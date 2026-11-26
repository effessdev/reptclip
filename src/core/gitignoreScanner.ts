import * as fs from "fs/promises";
import * as path from "path";
import ignore, { Ignore } from "ignore";

interface IgnoreLevel {
  /** Absolute directory the .gitignore file that produced `ig` lives in. */
  dir: string;
  ig: Ignore;
  /** Whether this level matches case-insensitively, following `core.ignorecase`. */
  ignorecase: boolean;
  /** Only the positive directory patterns (`build/`) from this file. */
  dirOnly: Ignore;
  /** Raw positive directory patterns, needed to tell a base rule from a deeper one. */
  dirOnlyLines: string[];
  /** Everything else from this file (file patterns, negations). */
  nonDir: Ignore;
}

// -----------------------------------------------------------------------------
// .gitignore parsing
// -----------------------------------------------------------------------------

const ALWAYS_IGNORED_DIR_NAMES = new Set([".git"]);

/** The application-specific ignore file, read next to every `.gitignore`. */
const PROTECTION_FILE = ".reptclipignore";

/** Builds a level, splitting directory patterns so a re-include can be scoped. */
function makeLevel(
  dir: string,
  content: string | null,
  ignorecase: boolean,
): IgnoreLevel {
  const options = { ignorecase };
  const empty = ignore(options);
  if (content === null) {
    return {
      dir,
      ig: empty,
      dirOnly: empty,
      dirOnlyLines: [],
      nonDir: empty,
      ignorecase,
    };
  }
  const lines = content.split(/\r?\n/);
  const dirOnlyLines = lines.filter((line) => {
    const trimmed = line.trim();
    return (
      trimmed.endsWith("/") &&
      !trimmed.startsWith("!") &&
      !trimmed.startsWith("#")
    );
  });
  const nonDirLines = lines.filter((line) => !dirOnlyLines.includes(line));
  return {
    dir,
    ig: ignore(options).add(content),
    dirOnly: ignore(options).add(dirOnlyLines.join("\n")),
    dirOnlyLines,
    nonDir: ignore(options).add(nonDirLines.join("\n")),
    ignorecase,
  };
}

const CONFIG_TRUE = new Set(["true", "yes", "on", "1"]);
const CONFIG_FALSE = new Set(["false", "no", "off", "0", ""]);

/**
 * `#` and `;` start a comment outside quotes, exactly as git reads them.
 */
function stripConfigComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" || ch === ";") {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

/**
 * `core.ignorecase` from the repository config, parsed the way git's bool type
 * reads it (`true`/`yes`/`on`/`1`, `false`/`no`/`off`/`0`, and a bare key
 * meaning true), and only from the `[core]` section. `include.path` and the
 * global config are not followed: the repository's own answer covers the
 * common case, and a wrong `false` only makes the guard stricter.
 */
/**
 * A quoted git value: `"true"`, `"a\"b"`. Git strips the quotes and expands the
 * usual escapes before the bool parser sees the value.
 */
function parseConfigValue(value: string): string {
  const text = value.trim();
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) {
    return text;
  }
  let out = "";
  for (let i = 1; i < text.length - 1; i += 1) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length - 1) {
      const escaped = text[i + 1];
      out +=
        escaped === "n"
          ? "\n"
          : escaped === "t"
            ? "\t"
            : escaped === "b"
              ? "\b"
              : escaped;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * `core.ignorecase` from the repository config, parsed the way git's bool type
 * reads it: `true`/`yes`/`on`/`1` are true, `false`/`no`/`off`/`0` are false, a
 * bare key is true, and an explicit empty value (`ignorecase =`) is false. Those
 * last two look alike but git maps them differently — checked against
 * `git config --bool`.
 *
 * Only `[core]` counts: a subsection (`[core "x"]` is the section `core.x`) is a
 * different key, and it must not leave the previous section active. Comments
 * after a header are legal, and a quoted value is unquoted before conversion.
 * `include.path` and the global config are not followed: the repository's own
 * answer covers the common case, and a wrong `false` only makes the guard
 * stricter.
 */
async function readGitConfigIgnoreCase(
  rootDir: string,
): Promise<boolean | undefined> {
  const repository = await resolveRepository(rootDir);
  if (!repository.common) {
    return undefined;
  }
  const config = await readFileIfExists(path.join(repository.common, "config"));
  if (config === null) {
    return undefined;
  }
  let section = "";
  let verdict: boolean | undefined;
  for (const raw of config.split(/\r?\n/)) {
    // Comments first: `[core] # settings` is the header `[core]`.
    const line = stripConfigComment(raw);
    if (line === "") {
      continue;
    }
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"([^"]*)")?\s*\]$/.exec(line);
    if (header) {
      const base = header[1].toLowerCase();
      section =
        header[2] === undefined ? base : `${base}.${header[2].toLowerCase()}`;
      continue;
    }
    const withValue = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    const bareKey = withValue ? null : /^([A-Za-z][A-Za-z0-9-]*)$/.exec(line);
    if (!withValue && !bareKey) {
      continue;
    }
    if (section !== "core") {
      continue;
    }
    const key = (withValue ?? bareKey)![1].toLowerCase();
    if (key !== "ignorecase") {
      continue;
    }
    const value = withValue
      ? parseConfigValue(withValue[2]).toLowerCase()
      : "true";
    if (CONFIG_TRUE.has(value)) {
      verdict = true;
    } else if (CONFIG_FALSE.has(value)) {
      verdict = false;
    }
  }
  return verdict;
}

/**
 * Whether this project treats `A` and `a` as the same path, in git's own
 * terms: `core.ignorecase` when it is set, else a read-only probe of the
 * workspace volume. `ignore` defaults to case-insensitive matching, but git is
 * case-sensitive unless `core.ignorecase` says otherwise, so the default would
 * over-exclude files on Linux and under `core.ignorecase=false`.
 */
async function detectIgnoreCase(rootDir: string): Promise<boolean> {
  const configured = await readGitConfigIgnoreCase(rootDir);
  return configured ?? (await probeCaseInsensitive(rootDir));
}

/**
 * Read-only probe: a folder named `Project` is the same folder as `PROJECT`
 * only on a case-insensitive volume. Falls back to the platform default when
 * the name has no letters to flip.
 */
async function probeCaseInsensitive(rootDir: string): Promise<boolean> {
  const base = path.basename(path.normalize(rootDir));
  const flipped = /[a-z]/.test(base) ? base.toUpperCase() : base.toLowerCase();
  if (flipped !== base) {
    try {
      const [original, other] = await Promise.all([
        fs.stat(rootDir, { bigint: true }),
        fs.stat(path.join(path.dirname(path.normalize(rootDir)), flipped), {
          bigint: true,
        }),
      ]);
      return (
        original.ino !== 0n &&
        original.dev === other.dev &&
        original.ino === other.ino
      );
    } catch {
      return false;
    }
  }
  return process.platform === "win32" || process.platform === "darwin";
}

/**
 * The repository a workspace belongs to. A workspace is often a subdirectory
 * of the repository, and git still applies every `.gitignore` from the
 * repository root down, so the scan starts at the git root rather than at the
 * folder the panel was opened on.
 */
async function findGitRoot(startDir: string): Promise<string | undefined> {
  let dir = path.resolve(startDir);
  for (;;) {
    const marker = path.join(dir, ".git");
    try {
      const info = await fs.stat(marker);
      if (info.isDirectory()) {
        // A directory named `.git` without HEAD is not a repository; do not
        // inherit rules from an arbitrary ancestor because of it.
        await fs.access(path.join(marker, "HEAD"));
        return dir;
      }
      if (info.isFile()) {
        const pointer = await readFileIfExists(marker);
        if (pointer && /^\s*gitdir:\s*\S+/m.test(pointer)) {
          return dir;
        }
      }
    } catch {
      // No repository marker here; keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

async function resolveRepository(
  rootDir: string,
): Promise<{ root: string; common?: string }> {
  const root = (await findGitRoot(rootDir)) ?? path.resolve(rootDir);
  return { root, common: await resolveGitCommonDir(root) };
}

/**
 * Resolves the `$GIT_COMMON_DIR`: for a normal checkout it is `.git`; for a
 * linked worktree or a submodule `.git` is a file pointing at the per-checkout
 * git dir, whose `commondir` names the shared one. `info/exclude` lives in the
 * common dir (gitignore(5): `$GIT_COMMON_DIR/info/exclude`).
 */
async function resolveGitCommonDir(
  rootDir: string,
): Promise<string | undefined> {
  const dotGit = path.join(rootDir, ".git");
  let info;
  try {
    info = await fs.stat(dotGit);
  } catch {
    return undefined;
  }
  if (info.isDirectory()) {
    return dotGit;
  }
  if (!info.isFile()) {
    return undefined;
  }
  const pointer = await readFileIfExists(dotGit);
  const match = pointer && /^\s*gitdir:\s*(.+?)\s*$/m.exec(pointer);
  if (!match) {
    return undefined;
  }
  const gitDir = path.resolve(rootDir, match[1]);
  const common = await readFileIfExists(path.join(gitDir, "commondir"));
  return common ? path.resolve(gitDir, common.trim()) : gitDir;
}

/**
 * Patterns from `$GIT_COMMON_DIR/info/exclude`, or null when there are none.
 * git treats exclude sources outside the working tree as if they sat at the
 * repository root, so they become a root-scoped level *below* any `.gitignore`
 * (a `.gitignore` negation still wins).
 */
async function readExcludePatterns(rootDir: string): Promise<string | null> {
  const repository = await resolveRepository(rootDir);
  if (!repository.common) {
    return null;
  }
  const content = await readFileIfExists(
    path.join(repository.common, "info", "exclude"),
  );
  return content && content.trim() !== "" ? content : null;
}

/**
 * Levels that come from above the workspace: `info/exclude`, then every
 * `.gitignore` from the repository root down to (but not including) the
 * workspace folder. The workspace's own `.gitignore` is added by the walker or
 * by the guard's per-directory cache, exactly once.
 *
 * `excluded` is set when a rule above the workspace excludes the workspace
 * folder itself: git applies nothing from inside an excluded directory, so both
 * entry points must see no files at all.
 */
interface IgnoreSources {
  git: IgnoreLevel[];
  clip: IgnoreLevel[];
}

/** Per-source re-inclusion base; the two sources re-include independently. */
interface ReincludeBases {
  git?: string;
  clip?: string;
}

interface InheritedLevels {
  levels: IgnoreSources;
  bases: ReincludeBases;
  /**
   * Set when the workspace folder itself is excluded by an ancestor rule of
   * either source. Descendant paths are then judged relative to the source's
   * own re-inclusion base, exactly as the walker does inside the tree.
   */
  excluded?: string;
}

async function inheritedLevels(
  rootDir: string,
  ignorecase: boolean,
): Promise<InheritedLevels> {
  const repository = await resolveRepository(rootDir);
  const levels: IgnoreSources = { git: [], clip: [] };
  const bases: ReincludeBases = {};
  const exclude = await readExcludePatterns(rootDir);
  if (exclude !== null) {
    levels.git.push(makeLevel(repository.root, exclude, ignorecase));
  }

  const relative = path.relative(repository.root, path.resolve(rootDir));
  if (isOutsidePath(relative)) {
    return { levels, bases };
  }
  const segments = relative === "" ? [] : relative.split(path.sep);
  let dir = repository.root;
  for (const segment of segments) {
    const git = await readIgnoreFile(path.join(dir, ".gitignore"));
    if (git !== null) {
      levels.git.push(makeLevel(dir, git, ignorecase));
    }
    const clip = await readIgnoreFile(path.join(dir, PROTECTION_FILE));
    if (clip !== null) {
      levels.clip.push(makeLevel(dir, clip, ignorecase));
    }
    const child = path.join(dir, segment);
    // Neither source may re-include anything under a directory it excludes, so
    // judge each step on the way down, with that source's own levels and base.
    const gitVerdict = verdictOf(child, true, levels.git, bases.git);
    const clipVerdict = verdictOf(child, true, levels.clip, bases.clip);
    if (gitVerdict === "ignored" || clipVerdict === "ignored") {
      return { levels, bases, excluded: child };
    }
    if (gitVerdict === "unignored") {
      bases.git = child;
    }
    if (clipVerdict === "unignored") {
      bases.clip = child;
    }
    dir = child;
  }
  // The bases must come back with the levels: a workspace that a deeper ignore
  // file re-includes has its files judged relative to itself, and a caller that
  // starts from `undefined` drops every one of them.
  return { levels, bases };
}

function isOutsidePath(relative: string): boolean {
  return (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Recursively walks `rootDir` and returns every file's path relative to
 * `rootDir` (posix-style separators) that is NOT excluded by any
 * .gitignore found along the way.
 *
 * This mirrors git's own layering behaviour without shelling out to git:
 * every directory's .gitignore is scoped to that directory and below, and
 * rules accumulate as you descend. The `ignore` package (npm) is used for
 * the actual pattern matching at each level, since gitignore pattern
 * semantics are easy to get subtly wrong by hand.
 */
export async function collectNonIgnoredFiles(
  rootDir: string,
): Promise<string[]> {
  const results: string[] = [];
  // Walk the real directory: a workspace opened through a junction must still
  // find the repository above it, and its ignore levels are anchored to real
  // paths.
  const root = await fs.realpath(rootDir).catch(() => path.resolve(rootDir));
  const ignorecase = await detectIgnoreCase(root);
  const { levels, bases, excluded } = await inheritedLevels(root, ignorecase);
  if (excluded) {
    // An ancestor rule excludes the workspace folder itself, so nothing inside
    // it is a file git (or the project) would track.
    return [];
  }
  await walk(root, root, levels, bases, results, ignorecase);
  return results.sort();
}

/** Names the ignore file(s) that excluded a path, for the panel message. */
function ignoreReason(gitIgnored: boolean, clipIgnored: boolean): string {
  if (gitIgnored && clipIgnored) {
    return "ignored by .gitignore and .reptclipignore";
  }
  return clipIgnored ? "ignored by .reptclipignore" : "ignored by .gitignore";
}

/** Verdict from the embedding guard: may this path be read into context? */
export interface EmbedVerdict {
  ok: boolean;
  /** Human-readable cause, shown in the panel when `ok` is false. */
  reason?: string;
  /** Canonical path to read; set when `ok` is true. */
  absPath?: string;
}

/**
 * Builds the single chokepoint that decides whether a relative path may be
 * embedded in generated context. Every read that feeds the Markdown output
 * goes through it, so ignored files can never slip in — no matter which
 * feature asked for them.
 *
 * The rules are exactly the ones the full-tree scan applies: layered,
 * per-directory `.gitignore` evaluation (root rules down to the file's own
 * directory, via the `ignore` package) plus the unconditional `.git`
 * exclusion. Since it consults the same `.gitignore` files (cached per
 * directory across calls), anything `collectNonIgnoredFiles` would have
 * listed passes here and anything it skipped does not.
 *
 * Absolute paths and anything resolving outside `rootDir` are rejected too, so
 * a hand-written or chatbot-generated list can't reach the filesystem beyond
 * the project.
 */
export function createEmbeddingGuard(
  rootDir: string,
): (relPath: string) => Promise<EmbedVerdict> {
  const rootNorm = path.normalize(rootDir);
  const rootRealPromise = fs.realpath(rootNorm).catch(() => undefined);
  const levelsCache = new Map<string, Promise<IgnoreSources>>();
  // All path rules are evaluated against the real directory, so a workspace
  // opened through a junction still sees the repository's ignore levels.
  let rootBase = rootNorm;
  const settings = rootRealPromise.then(async (real) => {
    rootBase = real ?? rootNorm;
    const ignorecase = await detectIgnoreCase(rootBase);
    const { levels, bases, excluded } = await inheritedLevels(
      rootBase,
      ignorecase,
    );
    return { levels, bases, ignorecase, excluded };
  });

  // Levels for `dirAbs`, inherited from its ancestors and extended by its own
  // ignore files when present. Memoized per directory, so checking many files
  // in one folder reads that folder's files once.
  const levelsFor = (dirAbs: string): Promise<IgnoreSources> => {
    const key = path.normalize(dirAbs);
    const cached = levelsCache.get(key);
    if (cached) {
      return cached;
    }

    const pending = (async () => {
      const { levels, ignorecase } = await settings;
      const parent = path.dirname(key);
      const inherited =
        key === rootBase || parent === key ? levels : await levelsFor(parent);
      const git = await readIgnoreFile(path.join(key, ".gitignore"));
      const clip = await readIgnoreFile(path.join(key, PROTECTION_FILE));
      if (git === null && clip === null) {
        return inherited;
      }
      return {
        git:
          git === null
            ? inherited.git
            : [...inherited.git, makeLevel(key, git, ignorecase)],
        clip:
          clip === null
            ? inherited.clip
            : [...inherited.clip, makeLevel(key, clip, ignorecase)],
      };
    })();

    levelsCache.set(key, pending);
    return pending;
  };

  /**
   * Walks `target`'s ancestors from the workspace root, per source, and returns
   * the first source that excludes one of them together with the re-inclusion
   * bases found on the way. A file verdict alone is not enough: the deepest
   * level can say `unignored` for a file while an ancestor is still excluded,
   * which is exactly how an alias slips past the lexical check.
   */
  const walkAncestors = async (
    target: string,
    inheritedBases: ReincludeBases,
  ): Promise<{ ignored: "git" | "clip" | null; bases: ReincludeBases }> => {
    const bases: ReincludeBases = { ...inheritedBases };
    let ancestor = rootBase;
    const parts = path
      .relative(rootBase, target)
      .split(path.sep)
      .slice(0, -1);
    for (const segment of parts) {
      ancestor = path.join(ancestor, segment);
      const sources = await levelsFor(path.dirname(ancestor));
      const gitVerdict = verdictOf(ancestor, true, sources.git, bases.git);
      const clipVerdict = verdictOf(ancestor, true, sources.clip, bases.clip);
      if (gitVerdict === "ignored") {
        return { ignored: "git", bases };
      }
      if (clipVerdict === "ignored") {
        return { ignored: "clip", bases };
      }
      if (gitVerdict === "unignored") {
        bases.git = ancestor;
      }
      if (clipVerdict === "unignored") {
        bases.clip = ancestor;
      }
    }
    return { ignored: null, bases };
  };

  return async (relPath: string): Promise<EmbedVerdict> => {
    const segments = relPath.split(/[\\/]+/).filter(Boolean);

    if (segments.length === 0) {
      return { ok: false, reason: "empty path" };
    }
    if (path.isAbsolute(relPath)) {
      return {
        ok: false,
        reason: "absolute path; must be relative to the project root",
      };
    }
    if (segments.some((s) => ALWAYS_IGNORED_DIR_NAMES.has(s))) {
      return { ok: false, reason: "inside .git, which is never embedded" };
    }

    const rootReal = await rootRealPromise;
    if (rootReal === undefined) {
      return { ok: false, reason: "project root is not readable" };
    }
    const { excluded, bases: inheritedBases } = await settings;
    if (excluded) {
      // An ancestor rule excludes the workspace folder itself; nothing below it
      // is re-included, not even through an ignore file in here.
      return {
        ok: false,
        reason: "the workspace folder is ignored by .gitignore or .reptclipignore",
      };
    }
    const absPath = path.normalize(path.join(rootReal, ...segments));
    if (absPath !== rootReal && !absPath.startsWith(rootReal + path.sep)) {
      return { ok: false, reason: "resolves outside the project root" };
    }

    // A link inside the project can point outside it; the guard has to judge
    // what the read will actually touch, not the spelling of the path.
    const resolved = await resolveRealInside(rootReal, absPath);
    if (!resolved.ok) {
      return resolved;
    }

    // The lexical name can be an alias: a link inside the project may point at
    // an ignored file or at .git. Judge the canonical target too.
    const realRel = path
      .relative(rootReal, resolved.absPath)
      .split(path.sep)
      .filter(Boolean);
    if (realRel.some((segment) => ALWAYS_IGNORED_DIR_NAMES.has(segment))) {
      return { ok: false, reason: "inside .git, which is never embedded" };
    }
    if (realRel.length > 0 && realRel.join("/") !== segments.join("/")) {
      const realAbs = path.join(rootBase, ...realRel);
      const realWalk = await walkAncestors(realAbs, inheritedBases);
      if (realWalk.ignored !== null) {
        return {
          ok: false,
          reason: ignoreReason(
            realWalk.ignored === "git",
            realWalk.ignored === "clip",
          ),
        };
      }
      const realSources = await levelsFor(path.dirname(realAbs));
      const realGit =
        verdictOf(realAbs, false, realSources.git, realWalk.bases.git) ===
        "ignored";
      const realClip =
        verdictOf(realAbs, false, realSources.clip, realWalk.bases.clip) ===
        "ignored";
      if (realGit || realClip) {
        return { ok: false, reason: ignoreReason(realGit, realClip) };
      }
    }

    const sources = await levelsFor(path.dirname(absPath));

    // An ignore file re-includes a directory when it negates a pattern from an
    // ancestor, and that re-inclusion carries to its contents. Walk the
    // ancestors first to find the innermost re-included directory per source,
    // then evaluate the file relative to it for shallower levels.
    // The workspace folder itself can be the re-included directory (a root rule
    // excludes `nested/build/`, `nested/.gitignore` says `!build/`, and the
    // panel is opened on `nested/build`). Starting from the inherited bases
    // keeps its files, which the walk below never revisits.
    const walk = await walkAncestors(absPath, inheritedBases);
    if (walk.ignored !== null) {
      return {
        ok: false,
        reason: ignoreReason(walk.ignored === "git", walk.ignored === "clip"),
      };
    }
    const bases = walk.bases;

    const gitIgnored =
      verdictOf(absPath, false, sources.git, bases.git) === "ignored";
    const clipIgnored =
      verdictOf(absPath, false, sources.clip, bases.clip) === "ignored";
    if (gitIgnored || clipIgnored) {
      return { ok: false, reason: ignoreReason(gitIgnored, clipIgnored) };
    }

    return { ok: true, absPath: resolved.absPath };
  };
}

// -----------------------------------------------------------------------------
// Filesystem safety
// -----------------------------------------------------------------------------

/**
 * Resolves a path to what the filesystem will actually touch, rejecting a link
 * that leaves the project (including a dangling one) and reporting a canonical
 * absolute path for the read.
 */
async function resolveRealInside(
  rootReal: string,
  absPath: string,
): Promise<{ ok: true; absPath: string } | { ok: false; reason: string }> {
  let probe = absPath;
  const trailing: string[] = [];
  for (;;) {
    let real: string | undefined;
    try {
      real = await fs.realpath(probe);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return {
          ok: false,
          reason: `cannot be resolved (${(err as Error).message})`,
        };
      }
      const linkInfo = await fs.lstat(probe).catch(() => undefined);
      if (linkInfo?.isSymbolicLink()) {
        return { ok: false, reason: "resolves through a dangling link" };
      }
    }
    if (real !== undefined) {
      const resolved = trailing.length ? path.resolve(real, ...trailing) : real;
      const rel = path.relative(rootReal, resolved);
      const inside =
        rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
      return inside
        ? { ok: true, absPath: resolved }
        : { ok: false, reason: "resolves outside the project root" };
    }
    const parent = path.dirname(probe);
    if (parent === probe) {
      return { ok: false, reason: "resolves outside the project root" };
    }
    trailing.unshift(path.basename(probe));
    probe = parent;
  }
}

// -----------------------------------------------------------------------------
// Directory traversal and ignore evaluation
// -----------------------------------------------------------------------------

async function walk(
  rootDir: string,
  currentDir: string,
  levels: IgnoreSources,
  bases: ReincludeBases,
  results: string[],
  ignorecase: boolean,
): Promise<void> {
  let sources = levels;

  const gitContent = await readIgnoreFile(path.join(currentDir, ".gitignore"));
  const clipContent = await readIgnoreFile(
    path.join(currentDir, PROTECTION_FILE),
  );
  if (gitContent !== null || clipContent !== null) {
    sources = {
      git:
        gitContent === null
          ? levels.git
          : [...levels.git, makeLevel(currentDir, gitContent, ignorecase)],
      clip:
        clipContent === null
          ? levels.clip
          : [...levels.clip, makeLevel(currentDir, clipContent, ignorecase)],
    };
  }

  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    // Directory vanished or is unreadable (permissions, symlink loop, etc).
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && ALWAYS_IGNORED_DIR_NAMES.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);
    const isDirectory = entry.isDirectory();
    const gitVerdict = verdictOf(fullPath, isDirectory, sources.git, bases.git);
    const clipVerdict = verdictOf(fullPath, isDirectory, sources.clip, bases.clip);

    if (gitVerdict === "ignored" || clipVerdict === "ignored") {
      continue;
    }

    if (entry.isSymbolicLink()) {
      // Avoid following symlinks to prevent infinite loops / escaping the root.
      continue;
    }

    if (isDirectory) {
      // A directory re-included by a deeper ignore file re-includes its whole
      // subtree, per source; shallower levels are then evaluated against it.
      const childBases: ReincludeBases = {
        git: gitVerdict === "unignored" ? fullPath : bases.git,
        clip: clipVerdict === "unignored" ? fullPath : bases.clip,
      };
      await walk(rootDir, fullPath, sources, childBases, results, ignorecase);
    } else if (entry.isFile()) {
      const relFromRoot = toPosixPath(path.relative(rootDir, fullPath));
      results.push(relFromRoot);
    }
  }
}

function isInsideDir(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/**
 * Checks whether an ignore match is caused only by an ancestor directory
 * that a deeper .gitignore has re-included.
 *
 * Independent exclusions below that directory still apply. In particular,
 * `build/` + `!build/` + `build/private/` must continue to exclude `private/`.
 */
function isInheritedDirectoryExclusion(
  level: IgnoreLevel,
  fullPath: string,
  isDirectory: boolean,
  reincludeBase: string | undefined,
): boolean {
  if (
    !reincludeBase ||
    reincludeBase === level.dir ||
    !isInsideDir(level.dir, reincludeBase)
  ) {
    return false;
  }

  const baseRel = toPosixPath(path.relative(level.dir, reincludeBase));
  if (!baseRel) {
    return false;
  }

  const relativePath = toPosixPath(path.relative(level.dir, fullPath));
  const candidate = isDirectory ? `${relativePath}/` : relativePath;
  const viaBaseDirectory = level.dirOnly.test(`${baseRel}/`).ignored;
  const viaOtherPattern = level.nonDir.ignores(candidate);

  // Test each directory rule separately to distinguish an inherited base
  // exclusion from a rule that independently excludes a directory below it.
  const baseRelDir = `${baseRel}/`;
  const directoryRules = level.dirOnlyLines.map((line) => ({
    ig: ignore({ ignorecase: level.ignorecase }).add(line),
  }));
  const matchesBase = directoryRules.some(
    (rule) => rule.ig.test(baseRelDir).ignored,
  );

  const relativeSegments = path
    .relative(reincludeBase, fullPath)
    .split(path.sep)
    .filter(Boolean);
  const directoriesBelow = isDirectory
    ? relativeSegments
    : relativeSegments.slice(0, -1);

  let subdirectory = reincludeBase;
  for (const segment of directoriesBelow) {
    subdirectory = path.join(subdirectory, segment);

    const subRelDir = `${toPosixPath(path.relative(level.dir, subdirectory))}/`;
    const suffixDir = `${toPosixPath(
      path.relative(reincludeBase, subdirectory),
    )}/`;

    const independentlyExcluded = directoryRules.some(
      (rule) =>
        rule.ig.test(subRelDir).ignored &&
        (!rule.ig.test(baseRelDir).ignored || rule.ig.test(suffixDir).ignored),
    );

    if (independentlyExcluded) {
      return false;
    }
  }

  return matchesBase && viaBaseDirectory && !viaOtherPattern;
}

/**
 * Effective verdict for one path. Deeper `.gitignore` files take precedence,
 * exactly like git, and a re-included ancestor (`reincludeBase`) makes
 * shallower levels see paths relative to that ancestor instead of their own
 * directory — so a root `build/` pattern does not hide files under a
 * `!build/` re-include.
 */
function verdictOf(
  fullPath: string,
  isDirectory: boolean,
  levels: IgnoreLevel[],
  reincludeBase?: string,
): "ignored" | "unignored" | "none" {
  for (let index = levels.length - 1; index >= 0; index -= 1) {
    const level = levels[index];
    // Patterns stay anchored to the .gitignore that defined them; only the
    // *cause* of an ignore is scoped to a re-included directory below.
    const rel = toPosixPath(path.relative(level.dir, fullPath));
    if (!rel || rel === ".." || rel.startsWith("../")) {
      continue;
    }
    // The `ignore` package wants directory patterns tested with matching
    // semantics; passing isDirectory lets patterns like `build/` match.
    const verdict = level.ig.test(isDirectory ? `${rel}/` : rel);
    if (verdict.ignored) {
      if (
        isInheritedDirectoryExclusion(
          level,
          fullPath,
          isDirectory,
          reincludeBase,
        )
      ) {
        continue;
      }
      return "ignored";
    }
    if (verdict.unignored) {
      return "unignored";
    }
  }
  return "none";
}

/**
 * Reads a `.gitignore` file the way git does: a symbolic link is not followed
 * (git warns and treats the file as absent), so the rules in its target do not
 * apply to the working tree.
 */
async function readIgnoreFile(filePath: string): Promise<string | null> {
  try {
    const info = await fs.lstat(filePath);
    if (info.isSymbolicLink()) {
      return null;
    }
  } catch {
    return null;
  }
  return readFileIfExists(filePath);
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}
