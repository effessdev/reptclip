# ARCHITECTURE

ReptClip is a VS Code webview extension that generates project context and applies Search/Replace diffs.

## Architecture

Three layers:

- **Webview UI** (`webview-ui/`): Browser-based interface. Communicates with the host through messages.
- **Host** (`src/panel/ReptclipViewProvider.ts`): Handles UI messages, coordinates core modules, and manages state and file watching.
- **Core** (`src/core/`): Handles file scanning, pattern matching, context generation, diff application, and VS Code services.

`ReptclipViewProvider.ts` is the central orchestrator; core modules expose functions and do not depend on each other.

## File inventory

### src

- `extension.ts`
  - `activate(context: vscode.ExtensionContext): void` — Registers the webview provider when the extension starts.
  - `deactivate(): void` — Runs on shutdown and leaves no persistent handles behind.
- `global.d.ts`
  - `No exported functions` — Declares the browser globals used by the webview script.

### src/core

- `clipboard.ts`
  - `copyToClipboard(text: string): Promise<void>` — Copies text to the VS Code clipboard.
  - `readClipboard(): Promise<string>` — Reads the current clipboard contents.
- `completions.ts`
  - `collectCandidates(rootDir: string): Promise<string[]>` — Scans the project for autocomplete candidates and parent folders.
  - `filterCandidates(candidates: string[], prefix: string, limit?: number): string[]` — Ranks and trims path matches for the current input.
- `core-behavior.test.ts`
  - `No exported functions` — Behavior tests covering the extension's main flows.
- `security-fixes.test.ts`
  - `No exported functions` — Regression tests for link escapes, protected write paths, undo conflicts, line endings and parser edge cases.
- `diff-format.md`
  - `No exported functions` — Embedded markdown describing the diff format shown to users.
- `diffApplier.ts`
  - `parseDiffBlocks(text: string): DiffBlock[]` — Parses SEARCH/REPLACE blocks into structured file edits.
  - `fingerprintDiff(text: string): string` — Creates a stable hash for deduplicating already-applied diffs.
  - `applyDiffs(rootDir: string, text: string): Promise<ApplyResult>` — Validates and applies diff blocks atomically to the workspace, returning a checkpoint for undo.
  - `applySnapshot(rootDir: string, files: FileSnapshot[], direction: "undo" | "redo"): Promise<ApplySummary>` — Restores a checkpoint's before/after file contents to support undo and redo.
  - `findBufferOverride(overrides: Map<string, string>, absPath: string, caseInsensitive: boolean): string | undefined` — Finds an editor buffer by file identity, falling back to a case-insensitive match on case-insensitive filesystems.
  - `ApplyOptions`, `SnapshotOptions` — Host hooks for confirmations and dirty-buffer overrides passed into `applyDiffs` / `applySnapshot`.
- `fileGuards.ts`
  - `readFileSafe(absPath: string): Promise<SafeReadResult>` — Reads files defensively, skipping binary or oversized content.
  - `countFileLines(absPath: string): Promise<number | undefined>` — Counts a file's raw lines, returning `undefined` for missing, oversized, or binary files.
- `generateContext.ts`
  - `generateContext(rootDir: string, state: UiState, showLineCounts?: boolean): Promise<GenerateResult>` — Builds the Markdown context for the selected project files, optionally annotating the project structure with per-file line counts.
  - `moreFiles(rootDir: string, pathList: string, includeFiles?: boolean): Promise<GenerateResult>` — Deprecated: embeds a clipboard-provided list of file paths; superseded by `moreContext`.
- `gitignoreScanner.ts`
  - `collectNonIgnoredFiles(rootDir: string): Promise<string[]>` — Recursively enumerates all non-ignored project files.
  - `createEmbeddingGuard(rootDir: string): (relPath: string) => Promise<EmbedVerdict>` — Validates whether a relative path may be embedded safely.
- `markdownBuilder.test.ts`
  - `No exported functions` — Regression tests for Markdown serialization and formatting.
- `markdownBuilder.ts`
  - `buildMarkdown(input: BuildMarkdownInput): string` — Assembles the final prompt text from project structure, file contents, and optional sections.
- `moreContext.ts`
  - `parseMoreContextCommands(text: string): MoreContextCommand[]` — Parses clipboard lines into `cat`/`grep` commands, collecting per-line errors for malformed input.
  - `moreContext(rootDir: string, commandText: string): Promise<MoreContextResult>` — Validates all commands up front, embeds `cat` files through the shared guard/read pipeline, runs `grep` searches via grepts, and returns one Markdown section per command.
  - `MoreContextCommand`, `GrepRequest`, `MoreContextResult` — Typed shapes for parsed commands, supported grep flags, and the generated supplement.
- `outputWriter.ts`
  - `writeOutputFile(rootDir: string, outputPath: string, content: string): Promise<void>` — Writes generated output to a file, creating directories as needed.
- `patternMatcher.ts`
  - `selectFiles(allFiles: string[], includePatterns: string[], excludePatterns: string[]): string[]` — Applies include/exclude glob logic to choose the final file set.
  - `matchesAnyFile(allFiles: string[], pattern: string): boolean` — Checks whether a glob matches at least one project file.
- `projectStorage.ts`
  - `loadProjectState(context: vscode.ExtensionContext, rootDir: string): UiState` — Loads per-project UI state from extension storage, falling back to the configured defaults for projects with no saved state.
  - `saveProjectState(context: vscode.ExtensionContext, rootDir: string, state: UiState): Promise<void>` — Persists UI state for the project.
  - `hasSavedProjectState(context: vscode.ExtensionContext, rootDir: string): boolean` — Reports whether a project already has saved UI state.
  - `getConfiguredDefaultUiState(): UiState` — Builds the default UI state from the `reptclip.default*` settings, falling back to `defaultUiState()` for any unset.
  - `loadLastAppliedFingerprint(context: vscode.ExtensionContext, rootDir: string): string | undefined` — Retrieves the last applied diff fingerprint.
  - `saveLastAppliedFingerprint(context: vscode.ExtensionContext, rootDir: string, fingerprint: string): Promise<void>` — Stores the current diff fingerprint for replay protection.
- `tokenizer.ts`
  - `tokenize(input: string): string[]` — Splits raw text into patterns while respecting quoted segments.
- `types.ts`
  - `defaultUiState(): UiState` — Creates the default persisted UI state for the panel.
- `uiLayout.test.ts`
  - `No exported functions` — Asserts that the panel markup, stylesheet and webview script keep the responsive include/exclude split layout.

### src/panel

- `getHtml.ts`
  - `getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string` — Builds the panel HTML shell and wires in the webview script and stylesheet.
- `ReptclipViewProvider.ts`
  - `ReptclipViewProvider` — Hosts the webview view and coordinates messages, file watching, and extension actions.
  - `resolveWebviewView(webviewView: vscode.WebviewView): void` — Initializes the panel, loads saved state, and handles message routing.

### webview-ui

- `main.js`
  - `No exported functions` — Browser-side UI logic for autocomplete, highlighting, validation, and message passing to the host.
- `style.css`
  - `No exported functions` — Styles for the panel layout, buttons, suggestions, and token highlighting.
