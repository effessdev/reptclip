import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { getHtml } from "./getHtml";
import {
  loadProjectState,
  saveProjectState,
  loadLastAppliedFingerprint,
  saveLastAppliedFingerprint,
  getConfiguredDefaultUiState,
  hasSavedProjectState,
  loadLabelsEnabled,
  saveLabelsEnabled,
} from "../core/projectStorage";
import { generateContext } from "../core/generateContext";
import { moreContext } from "../core/moreContext";
import { copyToClipboard, readClipboard } from "../core/clipboard";
import {
  applyDiffs,
  applySnapshot,
  fingerprintDiff,
  Checkpoint,
} from "../core/diffApplier";
import { writeOutputFile } from "../core/outputWriter";
import { collectCandidates, filterCandidates } from "../core/completions";
import { collectNonIgnoredFiles } from "../core/gitignoreScanner";
import { tokenize } from "../core/tokenizer";
import { matchesAnyFile } from "../core/patternMatcher";
import { HostToWebviewMessage, WebviewToHostMessage } from "../core/types";

export class ReptclipViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "reptclip.panelView";

  /** Checkpoints are capped per project so the undo/redo stacks stay bounded. */
  private static readonly MAX_CHECKPOINTS = 10;

  /**
   * Undo/redo checkpoints, keyed by project root. Held in memory only (not
   * persisted via projectStorage): a checkpoint carries full before/after
   * file contents, which is more than we want to write to globalState, and
   * stale undo history surviving a VS Code restart would be surprising
   * anyway. The stacks live as long as this provider instance, so they
   * persist across the panel being hidden/shown but reset on reload.
   */
  private undoStacks = new Map<string, Checkpoint[]>();
  private redoStacks = new Map<string, Checkpoint[]>();

  /** Cached workspace path list used for autocomplete; built on first use. */
  private candidates?: Promise<string[]>;

  /** Cached non-gitignored file list used for token highlighting. */
  private files?: Promise<string[]>;

  /** Last highlight evaluation, replayed whenever the file list changes. */
  private lastHighlight?: {
    requestId: number;
    attach: string;
    exclude: string;
  };

  /** Watches the workspace so the cached file list stays fresh. */
  private fileWatcher?: vscode.FileSystemWatcher;

  /** Debounce timer coalescing bursts of filesystem events. */
  private fileChangeTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    // NOTE: the view's context is kept alive across panel-tab switches via
    // `retainContextWhenHidden`, set at registration in extension.ts.
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "webview-ui"),
      ],
    };
    webviewView.webview.html = getHtml(webviewView.webview, this.extensionUri);

    const post = (message: HostToWebviewMessage) =>
      webviewView.webview.postMessage(message);

    const rootDir = this.getRootDir();
    const state = rootDir
      ? loadProjectState(this.context, rootDir)
      : getConfiguredDefaultUiState();
    post({
      type: "init",
      state,
      hasWorkspace: !!rootDir,
      canUndo: !!rootDir && (this.undoStacks.get(rootDir)?.length ?? 0) > 0,
      canRedo: !!rootDir && (this.redoStacks.get(rootDir)?.length ?? 0) > 0,
      labels: loadLabelsEnabled(this.context),
    });

    // Computes match flags for every attach/exclude token against the current
    // file list. Shared by the live request and the filesystem watcher below.
    const evaluateHighlight = async (
      requestId: number,
      attach: string,
      exclude: string,
    ) => {
      if (!rootDir) {
        return;
      }
      this.files ??= collectNonIgnoredFiles(rootDir);
      const files = await this.files;
      post({
        type: "highlightResult",
        requestId,
        attach: tokenize(attach).map((p) => matchesAnyFile(files, p)),
        exclude: tokenize(exclude).map((p) => matchesAnyFile(files, p)),
      });
    };

    // The cached file list goes stale the moment a file is created/deleted,
    // so watch the workspace, drop the cache, and re-evaluate the patterns
    // already in the boxes — that is what makes colors update in real time.
    if (rootDir) {
      this.fileWatcher?.dispose();
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(rootDir), "**/*"),
      );
      const scheduleRefresh = () => {
        if (this.fileChangeTimer) {
          clearTimeout(this.fileChangeTimer);
        }
        this.fileChangeTimer = setTimeout(() => {
          this.files = undefined; // force a fresh scan on the next evaluation
          this.candidates = undefined; // force a fresh candidate list for suggestions
          if (this.lastHighlight) {
            void evaluateHighlight(
              this.lastHighlight.requestId,
              this.lastHighlight.attach,
              this.lastHighlight.exclude,
            );
          }
        }, 200);
      };
      watcher.onDidCreate(scheduleRefresh);
      watcher.onDidChange(scheduleRefresh);
      watcher.onDidDelete(scheduleRefresh);
      this.fileWatcher = watcher;
      webviewView.onDidDispose(() => {
        watcher.dispose();
        if (this.fileWatcher === watcher) {
          this.fileWatcher = undefined;
        }
      });
    }

    // A new project (nothing saved yet) tracks the configured defaults live,
    // so editing a `reptclip.default*` setting updates the panel immediately
    // instead of only taking effect next time the panel is opened.
    if (rootDir) {
      const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("reptclip") &&
          !hasSavedProjectState(this.context, rootDir)
        ) {
          post({
            type: "init",
            state: getConfiguredDefaultUiState(),
            hasWorkspace: true,
            canUndo: (this.undoStacks.get(rootDir)?.length ?? 0) > 0,
            canRedo: (this.redoStacks.get(rootDir)?.length ?? 0) > 0,
            labels: loadLabelsEnabled(this.context),
          });
        }
      });
      webviewView.onDidDispose(() => configListener.dispose());
    }

    webviewView.webview.onDidReceiveMessage(
      async (message: WebviewToHostMessage) => {
        switch (message.type) {
          case "stateChanged": {
            if (rootDir) {
              await saveProjectState(this.context, rootDir, message.state);
            }
            return;
          }

          case "labelsChanged": {
            await saveLabelsEnabled(this.context, message.labels);
            return;
          }

          case "suggest": {
            if (!rootDir) {
              return;
            }
            this.candidates ??= collectCandidates(rootDir);
            const candidates = await this.candidates;
            post({
              type: "suggestResult",
              requestId: message.requestId,
              items: filterCandidates(candidates, message.prefix),
            });
            return;
          }

          case "highlight": {
            if (!rootDir) {
              return;
            }
            this.lastHighlight = {
              requestId: message.requestId,
              attach: message.attach,
              exclude: message.exclude,
            };
            await evaluateHighlight(
              message.requestId,
              message.attach,
              message.exclude,
            );
            return;
          }

          case "run": {
            if (!rootDir) {
              post({
                type: "runResult",
                ok: false,
                error: "Open a folder first.",
              });
              return;
            }

            await saveProjectState(this.context, rootDir, message.state);

            try {
              const showLineCounts = vscode.workspace
                .getConfiguration("reptclip")
                .get<boolean>("showLineCounts", true);
              const result = await generateContext(
                rootDir,
                message.state,
                showLineCounts,
              );

              if (message.state.clipboard) {
                await copyToClipboard(result.markdown);
              }
              if (message.state.outputFile.trim()) {
                await writeOutputFile(
                  rootDir,
                  message.state.outputFile,
                  result.markdown,
                );
              }

              post({
                type: "runResult",
                ok: true,
                fileCount: result.attachedFiles.length,
                structureFileCount: result.allFiles.length,
                copiedToClipboard: message.state.clipboard,
                writtenToFile: message.state.outputFile.trim().length > 0,
                tokenCount: result.tokenCount,
              });
            } catch (err) {
              const message_ = err instanceof Error ? err.message : String(err);
              post({ type: "runResult", ok: false, error: message_ });
            }
            return;
          }

          case "moreContext": {
            if (!rootDir) {
              post({
                type: "runResult",
                ok: false,
                error: "Open a folder first.",
              });
              return;
            }

            await saveProjectState(this.context, rootDir, message.state);

            try {
              const clipboardText = await readClipboard();
              if (!clipboardText.trim()) {
                throw new Error(
                  "Clipboard is empty. Please copy cat/grep commands first.",
                );
              }

              const result = await moreContext(rootDir, clipboardText);

              if (message.state.clipboard) {
                await copyToClipboard(result.markdown);
              }
              if (message.state.outputFile.trim()) {
                await writeOutputFile(
                  rootDir,
                  message.state.outputFile,
                  result.markdown,
                );
              }

              post({
                type: "runResult",
                ok: true,
                fileCount: result.attachedFiles.length,
                copiedToClipboard: message.state.clipboard,
                writtenToFile: message.state.outputFile.trim().length > 0,
                tokenCount: result.tokenCount,
                searchCount: result.searchCount,
                searchResultCount: result.searchResultCount,
              });
            } catch (err) {
              const message_ = err instanceof Error ? err.message : String(err);
              post({ type: "runResult", ok: false, error: message_ });
            }
            return;
          }

          case "applyDiffs": {
            if (!rootDir) {
              post({
                type: "applyResult",
                ok: false,
                error: "Open a folder first.",
              });
              return;
            }

            try {
              const clipboardText = await readClipboard();
              if (!clipboardText.trim()) {
                throw new Error(
                  "Clipboard is empty. Please copy a Search/Replace diff first.",
                );
              }

              const fingerprint = fingerprintDiff(clipboardText);
              // The "already applied" guard is persisted per project (only the
              // most recent diff), so it still holds after a VS Code restart.
              // When it trips we don't silently skip: the user can confirm to
              // re-apply the remembered diff anyway.
              if (
                loadLastAppliedFingerprint(this.context, rootDir) ===
                fingerprint
              ) {
                const choice = await vscode.window.showWarningMessage(
                  "This is the same diff as the last one applied to this project. Applying it again may duplicate changes. Re-apply anyway?",
                  { modal: true },
                  "Re-apply",
                );
                if (choice !== "Re-apply") {
                  post({
                    type: "applyResult",
                    ok: true,
                    modified: 0,
                    created: 0,
                    deleted: 0,
                    fuzzy: 0,
                    alreadyApplied: true,
                  });
                  return;
                }
              }

              const captured = this.captureBuffers();
              const result = await applyDiffs(rootDir, clipboardText, {
                bufferOverrides: captured.buffers,
                assertBuffersCurrent: captured.assertCurrent,
                confirmSuspiciousReplace: async (files) => {
                  const choice = await vscode.window.showWarningMessage(
                    `The REPLACE block for ${files.join(", ")} contains a "=======" line. That usually means a SEARCH separator was swallowed and more code will change than intended. Apply anyway?`,
                    { modal: true },
                    "Apply anyway",
                  );
                  return choice === "Apply anyway";
                },
                confirmGitignoreEdits: async (paths) => {
                  const choice = await vscode.window.showWarningMessage(
                    `This diff modifies .gitignore (${paths.join(", ")}). Changing it can un-ignore sensitive files, such as .env, so they would start being read and written by ReptClip. Apply anyway?`,
                    { modal: true },
                    "Apply anyway",
                  );
                  return choice === "Apply anyway";
                },
              });
              await saveLastAppliedFingerprint(
                this.context,
                rootDir,
                fingerprint,
              );

              this.pushCheckpoint(this.undoStacks, rootDir, result.checkpoint);
              this.redoStacks.set(rootDir, []);

              post({
                type: "applyResult",
                ok: true,
                modified: result.modified,
                created: result.created,
                deleted: result.deleted,
                fuzzy: result.fuzzy,
              });
              this.sendUndoRedoState(rootDir, post);
            } catch (err) {
              const message_ = err instanceof Error ? err.message : String(err);
              post({ type: "applyResult", ok: false, error: message_ });
            }
            return;
          }

          case "undo": {
            if (!rootDir) {
              post({
                type: "undoResult",
                ok: false,
                error: "Open a folder first.",
              });
              return;
            }

            const stack = this.undoStacks.get(rootDir);
            const checkpoint = stack?.pop();
            if (!checkpoint) {
              post({
                type: "undoResult",
                ok: false,
                error: "Nothing to undo.",
              });
              return;
            }

            try {
              // Check for disk changes before proceeding
              const diskChangedFiles: string[] = [];
              for (const file of checkpoint.files) {
                const absPath = path.resolve(rootDir, file.relPath);
                // For undo, we expect to find the "after" state on disk
                const hasChanged = await this.hasFileChangedOnDisk(
                  absPath,
                  file.after,
                );
                if (hasChanged) {
                  diskChangedFiles.push(file.relPath);
                }
              }

              if (diskChangedFiles.length > 0) {
                const choice = await vscode.window.showWarningMessage(
                  `${diskChangedFiles.join(", ")} changed on disk since this diff was applied. Undo will overwrite those changes. Continue?`,
                  { modal: true },
                  "Continue",
                );
                if (choice !== "Continue") {
                  stack?.push(checkpoint); // put it back
                  post({
                    type: "undoResult",
                    ok: false,
                    error: "Undo cancelled: files changed on disk.",
                  });
                  return;
                }
              }

              const captured = this.captureBuffers();
              const summary = await applySnapshot(
                rootDir,
                checkpoint.files,
                "undo",
                {
                  bufferOverrides: captured.buffers,
                  assertBuffersCurrent: captured.assertCurrent,
                  confirmConflict: (paths) =>
                    this.confirmDiscard(paths, "undo"),
                },
              );
              this.pushCheckpoint(this.redoStacks, rootDir, checkpoint);
              post({
                type: "undoResult",
                ok: true,
                modified: summary.modified,
                created: summary.created,
                deleted: summary.deleted,
              });
              this.sendUndoRedoState(rootDir, post);
            } catch (err) {
              stack?.push(checkpoint); // the undo didn't take, keep it available
              const message_ = err instanceof Error ? err.message : String(err);
              post({ type: "undoResult", ok: false, error: message_ });
            }
            return;
          }

          case "redo": {
            if (!rootDir) {
              post({
                type: "redoResult",
                ok: false,
                error: "Open a folder first.",
              });
              return;
            }

            const stack = this.redoStacks.get(rootDir);
            const checkpoint = stack?.pop();
            if (!checkpoint) {
              post({
                type: "redoResult",
                ok: false,
                error: "Nothing to redo.",
              });
              return;
            }

            try {
              // Check for disk changes before proceeding
              const diskChangedFiles: string[] = [];
              for (const file of checkpoint.files) {
                const absPath = path.resolve(rootDir, file.relPath);
                // For redo, we expect to find the "before" state on disk
                const hasChanged = await this.hasFileChangedOnDisk(
                  absPath,
                  file.before,
                );
                if (hasChanged) {
                  diskChangedFiles.push(file.relPath);
                }
              }

              if (diskChangedFiles.length > 0) {
                const choice = await vscode.window.showWarningMessage(
                  `${diskChangedFiles.join(", ")} changed on disk since this diff was applied. Redo will overwrite those changes. Continue?`,
                  { modal: true },
                  "Continue",
                );
                if (choice !== "Continue") {
                  stack?.push(checkpoint); // put it back
                  post({
                    type: "redoResult",
                    ok: false,
                    error: "Redo cancelled: files changed on disk.",
                  });
                  return;
                }
              }

              const captured = this.captureBuffers();
              const summary = await applySnapshot(
                rootDir,
                checkpoint.files,
                "redo",
                {
                  bufferOverrides: captured.buffers,
                  assertBuffersCurrent: captured.assertCurrent,
                  confirmConflict: (paths) =>
                    this.confirmDiscard(paths, "redo"),
                },
              );
              this.pushCheckpoint(this.undoStacks, rootDir, checkpoint);
              post({
                type: "redoResult",
                ok: true,
                modified: summary.modified,
                created: summary.created,
                deleted: summary.deleted,
              });
              this.sendUndoRedoState(rootDir, post);
            } catch (err) {
              stack?.push(checkpoint); // the redo didn't take, keep it available
              const message_ = err instanceof Error ? err.message : String(err);
              post({ type: "redoResult", ok: false, error: message_ });
            }
            return;
          }
        }
      },
    );
  }

  /**
   * Snapshot of every file-backed document. Dirty buffers replace the stale
   * disk copy; versions for *all* documents let the host abort if any target
   * becomes dirty or changes while the diff is resolved.
   */
  private captureBuffers(): {
    buffers: Map<string, string>;
    assertCurrent: () => void;
  } {
    const documents = vscode.workspace.textDocuments.filter(
      (document) => document.uri.scheme === "file",
    );
    const buffers = new Map<string, string>();
    const versions = new Map<string, number>();
    for (const document of documents) {
      versions.set(document.uri.toString(), document.version);
      if (document.isDirty) {
        buffers.set(document.uri.fsPath, document.getText());
      }
    }
    return {
      buffers,
      assertCurrent: () => {
        for (const document of documents) {
          if (versions.get(document.uri.toString()) !== document.version) {
            throw new Error(
              "A file changed while the diff was being prepared, so nothing was applied. Run Apply Diffs again.",
            );
          }
        }
      },
    };
  }

  /** Confirms undo/redo when the files changed after the checkpoint. */
  private async confirmDiscard(
    paths: string[],
    action: "undo" | "redo",
  ): Promise<boolean> {
    const label = action === "undo" ? "Undo" : "Redo";
    const choice = await vscode.window.showWarningMessage(
      `${paths.join(", ")} changed since this diff was applied. ${label} will overwrite those edits. Continue?`,
      { modal: true },
      "Continue",
    );
    return choice === "Continue";
  }

  /**
   * Checks if a file has changed on disk compared to the expected content.
   * Returns true if the file exists on disk with different content than expected.
   */
  private async hasFileChangedOnDisk(
    absPath: string,
    expectedContent: string | undefined,
  ): Promise<boolean> {
    try {
      const currentContent = await fs.readFile(absPath, "utf8");
      const currentExists = true;
      const expectedExists = expectedContent !== undefined;

      // File existence mismatch means it changed on disk
      if (currentExists !== expectedExists) {
        return true;
      }

      // Both exist but content differs
      if (
        currentExists &&
        expectedExists &&
        currentContent !== expectedContent
      ) {
        return true;
      }

      return false;
    } catch {
      // File doesn't exist on disk
      return expectedContent !== undefined;
    }
  }

  /** Pushes a checkpoint onto a stack, dropping the oldest once past the cap. */
  private pushCheckpoint(
    stacks: Map<string, Checkpoint[]>,
    rootDir: string,
    checkpoint: Checkpoint,
  ): void {
    const stack = stacks.get(rootDir) ?? [];
    stack.push(checkpoint);
    if (stack.length > ReptclipViewProvider.MAX_CHECKPOINTS) {
      stack.shift();
    }
    stacks.set(rootDir, stack);
  }

  /** Tells the webview whether the undo/redo buttons should be enabled. */
  private sendUndoRedoState(
    rootDir: string,
    post: (message: HostToWebviewMessage) => void,
  ): void {
    post({
      type: "undoRedoState",
      canUndo: (this.undoStacks.get(rootDir)?.length ?? 0) > 0,
      canRedo: (this.redoStacks.get(rootDir)?.length ?? 0) > 0,
    });
  }

  /**
   * Resolves the "current project" as the workspace folder containing the
   * active editor, falling back to the first open workspace folder.
   */
  private getRootDir(): string | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
      const folder = vscode.workspace.getWorkspaceFolder(activeUri);
      if (folder) {
        return folder.uri.fsPath;
      }
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }
}
