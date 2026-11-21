import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import { createEmbeddingGuard } from "./gitignoreScanner";

/**
 * Applies Search/Replace diff blocks copied from an LLM chat, following the
 * AI instructions emitted by `buildMarkdown` (see markdownBuilder.ts):
 *
 *   path/to/file.ext
 *   <<<<<<< SEARCH
 *   verbatim existing code
 *   =======
 *   replacement code
 *   >>>>>>> REPLACE
 *
 * An empty SEARCH creates a new file. An empty REPLACE removes the matched
 * text and leaves the file present, including when it becomes empty.
 */

interface DiffBlock {
  file: string;
  search: string;
  replace: string;
  /** A standalone file operation instead of a SEARCH/REPLACE block. */
  kind?: "move" | "delete";
  destination?: string;
}

export interface ApplySummary {
  modified: number;
  created: number;
  deleted: number;
  /** Blocks whose SEARCH matched only via the whitespace-lenient fallbacks. */
  fuzzy: number;
}

/**
 * The before/after content of a single file touched by an apply, keyed by
 * its workspace-relative path. `undefined` stands for "file does not exist"
 * on that side, so a snapshot can represent a creation or a deletion as well
 * as a plain content change.
 */
export interface FileSnapshot {
  relPath: string;
  before: string | undefined;
  after: string | undefined;
}

/** One applied diff's worth of undo/redo information. */
export interface Checkpoint {
  files: FileSnapshot[];
}

export interface ApplyResult extends ApplySummary {
  /** Lets the caller push this apply onto an undo stack. */
  checkpoint: Checkpoint;
}

/** Optional hooks a host provides so core code stays free of `vscode` dialogs. */
export interface ApplyOptions {
  /**
   * In-editor buffers that win over the on-disk copy, keyed by absolute path.
   * A dirty document is the truth the user sees; matching against the stale
   * disk copy would either miss the block or silently drop unsaved edits.
   */
  bufferOverrides?: Map<string, string>;
  /**
   * Called right before anything is written. The host uses it to abort if a
   * document changed while the diff was being resolved (TOCTOU).
   */
  assertBuffersCurrent?: () => void;
  /** Resolve true to allow writing paths the diff normally refuses to touch. */
  confirmProtectedPaths?: (paths: string[]) => Promise<boolean>;
  /**
   * Resolve true to apply a block whose REPLACE contains a `=======` line,
   * which usually means the SEARCH separator was swallowed by the parser.
   */
  confirmSuspiciousReplace?: (files: string[]) => Promise<boolean>;
}

/** Options for `applySnapshot` (undo/redo). */
export interface SnapshotOptions {
  /** In-editor buffers that win over the on-disk copy, keyed by absolute path. */
  bufferOverrides?: Map<string, string>;
  /** Abort if a document changed while undo/redo was being prepared. */
  assertBuffersCurrent?: () => void;
  /** Resolve true to overwrite files that changed since the checkpoint. */
  confirmConflict?: (paths: string[]) => Promise<boolean>;
}

/**
 * Checks whether a file has been modified on disk since the checkpoint was
 * recorded. Returns true if the file exists on disk with different content
 * than what's expected (the "after" state for undo, or "before" state for redo).
 */
async function hasDiskChanges(
  absPath: string,
  expectedContent: string | undefined,
): Promise<boolean> {
  const currentContent = await readFileIfExists(absPath);
  const currentExists = currentContent !== undefined;
  const expectedExists = expectedContent !== undefined;

  // File existence mismatch means it changed on disk
  if (currentExists !== expectedExists) {
    return true;
  }

  // Both exist but content differs
  if (currentExists && expectedExists && currentContent !== expectedContent) {
    return true;
  }

  return false;
}

const SEARCH_MARKER = "<<<<<<< SEARCH";
const SEPARATOR = "=======";
const REPLACE_MARKER = ">>>>>>> REPLACE";

/**
 * Paths whose write is refused unless the host confirms it. Two classes:
 *   - anything under `.git`: git executes content from there (hooks, aliases,
 *     `core.fsmonitor`), so a diff can become a command run on the next git call;
 *   - `.env` and `.env.*`: the diff comes from a chatbot, and swapping the
 *     project's environment file is a configuration change the user must see.
 *
 * NTFS alternate data streams are stripped before the comparison: `file.txt::$DATA`
 * is the same file, so `.env::$DATA` must not slip past the `.env` rule.
 */
function isProtectedPath(relative: string): boolean {
  const segments = relative.split(/[\\/]+/).filter(Boolean);
  if (
    segments.some((segment) => segment.split(":")[0].toLowerCase() === ".git")
  ) {
    return true;
  }
  const base = (segments[segments.length - 1] ?? "")
    .split(":")[0]
    .toLowerCase();
  return base === ".env" || base.startsWith(".env.");
}

/**
 * Line-based state machine. Outside a block, every non-empty line is treated
 * as a candidate file path — the one immediately preceding a `<<<<<<< SEARCH`
 * marker is the target of that block. Consecutive blocks for the same file
 * (multi-file example rule 6) simply reuse the last resolved path. Code
 * fences around the whole dump are skipped so both raw and fenced content
 * parse identically.
 */
export function parseDiffBlocks(text: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  const lines = text.split(/\r?\n/);

  let state: "outside" | "search" | "replace" = "outside";
  let currentFile: string | undefined;
  let candidatePath: string | undefined;
  let searchLines: string[] = [];
  let replaceLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (state === "outside") {
      if (trimmed.startsWith(SEARCH_MARKER)) {
        state = "search";
        searchLines = [];
        continue;
      }
      if (trimmed.startsWith("```") || trimmed === "") {
        continue;
      }

      const arrow = trimmed.match(/^(.+?)\s+->\s+(.+)$/);
      if (arrow) {
        blocks.push({
          file: arrow[1].trim(),
          destination: arrow[2].trim(),
          search: "",
          replace: "",
          kind: "move",
        });
        continue;
      }

      const deleteMatch = trimmed.match(/^(.+?)\s+delete$/i);
      if (deleteMatch) {
        blocks.push({
          file: deleteMatch[1].trim(),
          search: "",
          replace: "",
          kind: "delete",
        });
        continue;
      }

      candidatePath = trimmed;
      continue;
    }

    if (state === "search") {
      if (trimmed === SEPARATOR) {
        state = "replace";
        replaceLines = [];
        continue;
      }
      searchLines.push(line);
      continue;
    }

    // state === "replace"
    if (trimmed.startsWith(REPLACE_MARKER)) {
      const file = candidatePath ?? currentFile;
      if (!file) {
        throw new Error(
          "Found a SEARCH/REPLACE block with no file path before it.",
        );
      }
      blocks.push({
        file,
        search: searchLines.join("\n"),
        replace: replaceLines.join("\n"),
      });
      currentFile = file;
      candidatePath = undefined;
      state = "outside";
      continue;
    }
    replaceLines.push(line);
  }

  if (state !== "outside") {
    throw new Error("Truncated diff: a SEARCH/REPLACE block is not closed.");
  }
  return blocks;
}

/**
 * Stable content hash of a diff, derived from its parsed blocks (not the raw
 * clipboard text) so line-ending and surrounding-fence differences don't
 * produce a different fingerprint for the same change. Used to remember the
 * last applied diff and avoid re-applying it. Throws on malformed diffs, which
 * mirrors `applyDiffs` so callers surface the same error.
 */
export function fingerprintDiff(text: string): string {
  const blocks = parseDiffBlocks(text);
  if (blocks.length === 0) {
    throw new Error(
      "Clipboard does not contain any supported diff operations.",
    );
  }
  const canonical = blocks
    .map(
      (b) =>
        `${b.kind ?? "replace"}\u0000${b.file}\u0000${b.destination ?? ""}\u0000${b.search}\u0000${b.replace}`,
    )
    .join("\u0001");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Resolves a diff path against the workspace root, rejecting escapes. Returns
 * the lexical absolute path used for the edit and the workspace-relative real
 * path, so callers can apply path-based rules to what the write will actually
 * touch (a link can rename a protected target).
 */
async function resolveFile(
  rootDir: string,
  relative: string,
): Promise<{ absPath: string; realRelPath: string }> {
  const cleaned = relative
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
  const root = path.resolve(rootDir);
  const abs = path.resolve(root, cleaned);
  const prefix = root.toLowerCase() + path.sep;
  if (
    abs.toLowerCase() !== root.toLowerCase() &&
    !abs.toLowerCase().startsWith(prefix)
  ) {
    throw new Error(`Diff path escapes the workspace: ${relative}`);
  }

  // Lexical containment is not enough: a directory junction or symlink inside
  // the workspace makes `root/link/...` look local while the write lands
  // somewhere else. Resolve the real path of the deepest existing ancestor and
  // compare it with the real workspace root, so a link can never carry a diff
  // outside the project.
  const rootReal = await fs.realpath(root).catch(() => undefined);
  if (rootReal === undefined) {
    throw new Error(
      `Diff path escapes the workspace: ${relative} (workspace root is not readable)`,
    );
  }

  let probe = abs;
  const trailing: string[] = [];
  for (;;) {
    let probeReal: string | undefined;
    try {
      probeReal = await fs.realpath(probe);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `Diff path cannot be resolved: ${relative} (${(err as Error).message})`,
        );
      }
      // A dangling link still redirects the write: realpath() cannot follow it,
      // so it surfaces as ENOENT. lstat() sees the link itself and must reject.
      const linkInfo = await fs.lstat(probe).catch(() => undefined);
      if (linkInfo?.isSymbolicLink()) {
        throw new Error(
          `Diff path escapes the workspace: ${relative} (dangling link at ${probe})`,
        );
      }
    }
    if (probeReal !== undefined) {
      const resolved = trailing.length
        ? path.resolve(probeReal, ...trailing)
        : probeReal;
      if (!isInside(rootReal, resolved)) {
        throw new Error(
          `Diff path escapes the workspace: ${relative} (resolves to ${resolved})`,
        );
      }
      // Keep the original path so the edit targets the path the user sees, but
      // report where the write really lands so protected-path rules can use it.
      return {
        absPath: abs,
        realRelPath: path
          .relative(rootReal, resolved)
          .split(path.sep)
          .join("/"),
      };
    }
    const parent = path.dirname(probe);
    if (parent === probe) {
      throw new Error(`Diff path escapes the workspace: ${relative}`);
    }
    trailing.unshift(path.basename(probe));
    probe = parent;
  }
}

/** Whether `candidate` is `root` itself or lives inside it, using OS case rules. */
function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Buffer lookup by file identity. The provider keys buffers by `uri.fsPath`,
 * while a diff path keeps the casing the chatbot typed; on a case-insensitive
 * volume those are the same file but different strings. Platform is not a
 * reliable proxy (macOS can host case-sensitive APFS volumes, Windows can have
 * per-directory case sensitivity), so a case-insensitive candidate only wins
 * when the filesystem reports the same device and inode.
 */
export async function findBufferOverride(
  overrides: Map<string, string> | undefined,
  absPath: string,
): Promise<string | undefined> {
  if (!overrides) {
    return undefined;
  }
  const exact = overrides.get(absPath);
  if (exact !== undefined) {
    return exact;
  }
  const needle = absPath.toLowerCase();
  for (const [key, value] of overrides) {
    if (key.toLowerCase() === needle && (await isSameFile(key, absPath))) {
      return value;
    }
  }
  return undefined;
}

async function isSameFile(first: string, second: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([
      fs.stat(first, { bigint: true }),
      fs.stat(second, { bigint: true }),
    ]);
    return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

async function readFileIfExists(absPath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch {
    return undefined;
  }
}

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Builds progressively more forgiving regex patterns from the SEARCH lines,
 * mirroring the liberal matching ladders used by agent edit tools:
 *   1. ignore trailing whitespace on each line
 *   2. ...plus flexible leading indentation
 *   3. ...plus any whitespace run inside a line counts as equivalent
 *      (token-level matching, so tab-vs-space and re-indented code pass)
 */
function lenientPatterns(lines: string[]): string[] {
  const trailing = "[ \\t]*";
  const esc = escapeRegExp;
  const levels = [
    (l: string) => esc(l) + trailing,
    (l: string) => `[ \\t]*${esc(l.replace(/^[ \t]+/, ""))}${trailing}`,
    (l: string) => {
      const tokens = l.trim().split(/\s+/).filter(Boolean).map(esc);
      return tokens.length
        ? `[ \\t]*${tokens.join("[ \\t]+")}${trailing}`
        : "[ \\t]*";
    },
  ];
  return levels.map((perLine) => lines.map(perLine).join("\\r?\\n"));
}

/**
 * Locates `search` in `content`, refusing ambiguous matches. Tolerant of:
 *   - Trailing newlines (a block need not end exactly where the file does).
 *   - Line endings: clipboard text is LF after parsing, while files checked
 *     out on Windows are often CRLF. The REPLACE text is converted to
 *     whichever style matched, keeping the file's convention intact.
 *   - Whitespace drift, via the lenient ladder above (reported as "fuzzy"
 *     so callers can surface it for review).
 */
function findMatch(
  content: string,
  search: string,
  replace: string,
  file: string,
): { index: number; text: string; replace: string; fuzzy: boolean } {
  const normalizeReplace = (matched: string, value: string): string => {
    // A single-line SEARCH has no line ending of its own, so fall back to the
    // file's convention; otherwise a multi-line REPLACE injects LF into a CRLF
    // file and leaves it with mixed endings.
    const crlf = matched.includes("\r\n")
      ? true
      : matched.includes("\n")
        ? false
        : content.includes("\r\n");
    if (crlf) {
      return value.includes("\r\n") ? value : value.replace(/\n/g, "\r\n");
    }
    return value.includes("\r\n") ? value.replace(/\r\n/g, "\n") : value;
  };

  // Pass 0: byte-for-byte exact, in every line-ending combination.
  const lf = search.replace(/\r\n/g, "\n");
  const bases = [
    search, // as parsed (also covers search copied with CRLF)
    lf, // normalized to LF for CRLF-vs-LF comparison
    lf.replace(/\n/g, "\r\n"), // converted to CRLF for CRLF files
  ];

  let ambiguous = false;
  for (const base of bases) {
    for (const variant of [base, base.replace(/\r?\n+$/, "")]) {
      if (variant === "") {
        continue;
      }
      const count = content.split(variant).length - 1;
      if (count === 1) {
        return {
          index: content.indexOf(variant),
          text: variant,
          replace: normalizeReplace(variant, replace),
          fuzzy: false,
        };
      }
      if (count > 1) {
        ambiguous = true;
      }
    }
  }

  // Passes 1-3: whitespace-lenient fallbacks, strictest first.
  const body = search.replace(/\r?\n+$/, "");
  if (body !== "") {
    for (const pattern of lenientPatterns(body.split(/\r?\n/))) {
      const matches = [...content.matchAll(new RegExp(pattern, "g"))];
      if (matches.length === 1) {
        const match = matches[0];
        return {
          index: match.index,
          text: match[0],
          replace: normalizeReplace(match[0], replace),
          fuzzy: true,
        };
      }
      if (matches.length > 1) {
        ambiguous = true;
      }
    }
  }

  if (ambiguous) {
    throw new Error(
      `SEARCH block for ${file} matches multiple locations. Please provide more context.`,
    );
  }
  throw new Error(`No match found for the SEARCH block in ${file}.`);
}

interface FilePlan {
  absPath: string;
  /** Workspace-relative path (forward slashes), used to key a checkpoint. */
  relPath: string;
  existed: boolean;
  /** The file's content before this operation, if it existed. */
  original: string | undefined;
  content: string;
  deleted: boolean;
}

/**
 * Turns a set of file plans into disk changes via a single workspace edit:
 * creates, modifies, or deletes each file, saves the dirty buffers it
 * touched, and reveals them in the editor. Shared by `applyDiffs` (acting on
 * freshly matched SEARCH/REPLACE results) and `applySnapshot` (acting on a
 * stored checkpoint for undo/redo), so both paths commit changes identically.
 */
async function commitPlans(
  plans: Iterable<FilePlan>,
  assertBuffersCurrent?: () => void,
): Promise<{ modified: number; created: number; deleted: number }> {
  const edit = new vscode.WorkspaceEdit();
  let modified = 0;
  let created = 0;
  let deleted = 0;
  // Files whose edits land in an in-memory document buffer; saved below so the
  // user doesn't have to press Save on each one. Deletions need no save.
  const touched: vscode.Uri[] = [];
  for (const plan of plans) {
    const uri = vscode.Uri.file(plan.absPath);
    if (plan.deleted) {
      edit.deleteFile(uri, { ignoreIfNotExists: true });
      deleted++;
    } else if (!plan.existed) {
      edit.createFile(uri, { overwrite: true });
      edit.insert(uri, new vscode.Position(0, 0), plan.content);
      created++;
      touched.push(uri);
    } else {
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
      edit.replace(doc.uri, fullRange, plan.content);
      modified++;
      touched.push(uri);
    }
  }

  // Opening each document above awaits, so the user can edit a file after the
  // earlier check. Re-validate immediately before the edit is applied.
  assertBuffersCurrent?.();
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error("VS Code refused to apply the workspace edit.");
  }

  // `applyEdit` only mutates the documents and leaves them dirty, which is why
  // files used to appear unsaved. Save each one to persist the change. This
  // keeps the editor undo stack intact (unlike writing straight to disk), so a
  // fuzzy or unwanted match can still be reverted with Ctrl+Z.
  for (const uri of touched) {
    const doc = await vscode.workspace.openTextDocument(uri);
    await doc.save();
  }

  // Open each affected file as a pinned tab without stealing focus, so the
  // user sees all changes; then reveal the first one (in diff order) so
  // focus lands somewhere predictable instead of flickering through each.
  // If a file is already open, VS Code reuses its existing tab.
  for (const uri of touched) {
    await vscode.window.showTextDocument(uri, {
      preview: false,
      preserveFocus: true,
    });
  }
  if (touched.length > 0) {
    await vscode.window.showTextDocument(touched[0], { preview: false });
  }

  return { modified, created, deleted };
}

export async function applyDiffs(
  rootDir: string,
  text: string,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const blocks = parseDiffBlocks(text);
  if (blocks.length === 0) {
    throw new Error(
      "Clipboard does not contain any supported diff operations.",
    );
  }

  // A `=======` line inside the REPLACE half means the parser took the second
  // separator as the boundary: the intended SEARCH tail was folded into the
  // replacement and the edit silently changes more than the author asked for.
  // It cannot be told apart from a legitimate "======" line in the new code,
  // so the host has to confirm instead of the parser guessing.
  const suspiciousReplace = [
    ...new Set(
      blocks
        .filter(
          (block) =>
            block.kind === undefined &&
            block.replace
              .split(/\r?\n/)
              .some((line) => line.trim() === SEPARATOR),
        )
        .map((block) => block.file),
    ),
  ];
  if (suspiciousReplace.length > 0) {
    if (!options.confirmSuspiciousReplace) {
      throw new Error(
        `Refusing to apply: the REPLACE block for ${suspiciousReplace.join(", ")} ` +
          'contains a "=======" line, which usually means a SEARCH separator was ' +
          "swallowed. Split the edit into separate blocks or confirm explicitly.",
      );
    }
    const confirmed = await options.confirmSuspiciousReplace(suspiciousReplace);
    if (!confirmed) {
      throw new Error(
        `Apply cancelled: the "=======" line in ${suspiciousReplace.join(", ")} was not confirmed.`,
      );
    }
  }

  const resolvedTargets: { absPath: string; realRelPath: string }[] = [];
  const resolvedDestinations: (
    | { absPath: string; realRelPath: string }
    | undefined
  )[] = [];
  const protectedPaths = new Set<string>();
  const ignoredPaths = new Set<string>();
  const isEmbeddable = createEmbeddingGuard(rootDir);

  for (const block of blocks) {
    const target = await resolveFile(rootDir, block.file);
    resolvedTargets.push(target);
    if (isProtectedPath(block.file) || isProtectedPath(target.realRelPath)) {
      protectedPaths.add(block.file);
    }
    const verdict = await isEmbeddable(block.file);
    if (!verdict.ok && verdict.reason === "ignored by .gitignore") {
      ignoredPaths.add(block.file);
    }

    if (block.kind === "move") {
      if (!block.destination || block.destination.trim() === "") {
        throw new Error(`Move from ${block.file} has no destination path.`);
      }
      const destination = await resolveFile(rootDir, block.destination);
      resolvedDestinations.push(destination);
      if (
        isProtectedPath(block.destination!) ||
        isProtectedPath(destination.realRelPath)
      ) {
        protectedPaths.add(block.destination!);
      }
      const destVerdict = await isEmbeddable(block.destination!);
      if (!destVerdict.ok && destVerdict.reason === "ignored by .gitignore") {
        ignoredPaths.add(block.destination!);
      }
    } else {
      resolvedDestinations.push(undefined);
    }
  }

  if (protectedPaths.size > 0) {
    const files = [...protectedPaths];
    if (!options.confirmProtectedPaths) {
      throw new Error(
        `Refusing to write protected paths: ${files.join(", ")}. ` +
          ".git content is executed by git and .env* changes the project configuration. " +
          "Enable reptclip.allowProtectedFileWrites to confirm each apply.",
      );
    }
    const confirmed = await options.confirmProtectedPaths(files);
    if (!confirmed) {
      throw new Error(
        `Apply cancelled: protected paths were not confirmed (${files.join(", ")}).`,
      );
    }
  }

  if (ignoredPaths.size > 0) {
    const files = [...ignoredPaths];
    throw new Error(
      `Refusing to write files ignored by .gitignore: ${files.join(", ")}. ` +
        "Diffs can only touch tracked files — remove the matching .gitignore pattern first if you want ReptClip to manage them.",
    );
  }

  // Simulate every block, in order, per file so all validation happens
  // before anything touches disk.
  const plans = new Map<string, FilePlan>();
  let fuzzy = 0;
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const { absPath } = resolvedTargets[blockIndex];
    let plan = plans.get(absPath);
    if (!plan) {
      const original =
        (await findBufferOverride(options.bufferOverrides, absPath)) ??
        (await readFileIfExists(absPath));
      plan = {
        absPath,
        relPath: path
          .relative(path.resolve(rootDir), absPath)
          .split(path.sep)
          .join("/"),
        existed: original !== undefined,
        original,
        content: original ?? "",
        deleted: false,
      };
      plans.set(absPath, plan);
    }
    if (plan.deleted) {
      throw new Error(`Diff edits ${block.file} after it was deleted.`);
    }

    if (block.kind === "delete") {
      if (!plan.existed) {
        throw new Error(
          `Cannot delete ${block.file}: the file does not exist.`,
        );
      }
      plan.deleted = true;
      continue;
    }

    if (block.kind === "move") {
      if (!plan.existed) {
        throw new Error(`Cannot move ${block.file}: the file does not exist.`);
      }
      const destination = resolvedDestinations[blockIndex]!;
      if (destination.absPath.toLowerCase() === absPath.toLowerCase()) {
        throw new Error(
          `Cannot move ${block.file}: source and destination are the same path.`,
        );
      }

      let destinationPlan = plans.get(destination.absPath);
      if (!destinationPlan) {
        const destinationContent =
          (await findBufferOverride(
            options.bufferOverrides,
            destination.absPath,
          )) ?? (await readFileIfExists(destination.absPath));
        destinationPlan = {
          absPath: destination.absPath,
          relPath: path
            .relative(path.resolve(rootDir), destination.absPath)
            .split(path.sep)
            .join("/"),
          existed: destinationContent !== undefined,
          original: destinationContent,
          content: destinationContent ?? "",
          deleted: false,
        };
        plans.set(destination.absPath, destinationPlan);
      }
      if (destinationPlan.existed) {
        throw new Error(
          `Cannot move ${block.file} to ${block.destination}: destination already exists.`,
        );
      }
      destinationPlan.existed = false;
      destinationPlan.original = undefined;
      destinationPlan.content = plan.content;
      destinationPlan.deleted = false;
      plan.deleted = true;
      continue;
    }

    if (block.search === "") {
      // Empty SEARCH: create (or keep appending to a file being created).
      if (plan.existed && plan.content.trim() !== "") {
        throw new Error(
          `${block.file} already exists. An empty SEARCH block is only for new files.`,
        );
      }
      plan.content += block.replace;
      continue;
    }

    if (!plan.existed && plan.content === "") {
      throw new Error(
        `No match found for the SEARCH block in ${block.file}: the file does not exist. ` +
          "A file path must be on its own line immediately before <<<<<<< SEARCH.",
      );
    }

    const {
      index,
      text,
      replace,
      fuzzy: lenient,
    } = findMatch(plan.content, block.search, block.replace, block.file);
    if (lenient) {
      fuzzy++;
    }
    plan.content =
      plan.content.slice(0, index) +
      replace +
      plan.content.slice(index + text.length);
  }

  const snapshot: FileSnapshot[] = Array.from(plans.values()).map((plan) => ({
    relPath: plan.relPath,
    before: plan.existed ? plan.original : undefined,
    after: plan.deleted ? undefined : plan.content,
  }));

  options.assertBuffersCurrent?.();
  const { modified, created, deleted } = await commitPlans(
    plans.values(),
    options.assertBuffersCurrent,
  );

  return {
    modified,
    created,
    deleted,
    fuzzy,
    checkpoint: { files: snapshot },
  };
}

/**
 * Restores a checkpoint's file contents in the given direction: "undo" sets
 * every file back to its pre-apply content (deleting ones that didn't exist
 * yet), "redo" re-applies the post-apply content (deleting ones the original
 * apply had removed).
 *
 * The current content is compared with the state the checkpoint expects to find
 * on disk (the "after" side for undo, the "before" side for redo). A mismatch
 * means the file was edited after the checkpoint was recorded, so restoring it
 * would destroy that work; nothing is written until the caller confirms.
 */
export async function applySnapshot(
  rootDir: string,
  files: FileSnapshot[],
  direction: "undo" | "redo",
  options: SnapshotOptions = {},
): Promise<ApplySummary> {
  const plans: FilePlan[] = [];
  const conflicts: string[] = [];
  for (const file of files) {
    const target = direction === "undo" ? file.before : file.after;
    const expected = direction === "undo" ? file.after : file.before;
    const { absPath } = await resolveFile(rootDir, file.relPath);
    const currentContent =
      (await findBufferOverride(options.bufferOverrides, absPath)) ??
      (await readFileIfExists(absPath));
    const currentExists = currentContent !== undefined;

    if (currentExists && currentContent !== expected) {
      conflicts.push(file.relPath);
    }

    if (target === undefined) {
      if (currentExists) {
        plans.push({
          absPath,
          relPath: file.relPath,
          existed: true,
          original: currentContent,
          content: "",
          deleted: true,
        });
      }
      continue;
    }

    plans.push({
      absPath,
      relPath: file.relPath,
      existed: currentExists,
      original: currentContent,
      content: target,
      deleted: false,
    });
  }

  if (conflicts.length > 0) {
    const action = direction === "undo" ? "Undo" : "Redo";
    if (!options.confirmConflict) {
      throw new Error(
        `Files changed since this diff was recorded: ${conflicts.join(", ")}. ` +
          `${action} cancelled; revert those files by hand first.`,
      );
    }
    const confirmed = await options.confirmConflict(conflicts);
    if (!confirmed) {
      throw new Error(
        `${action} cancelled: ${conflicts.join(", ")} changed since the diff was applied.`,
      );
    }
  }

  options.assertBuffersCurrent?.();
  const { modified, created, deleted } = await commitPlans(
    plans,
    options.assertBuffersCurrent,
  );
  return { modified, created, deleted, fuzzy: 0 };
}
