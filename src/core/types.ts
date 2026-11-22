/**
 * The full set of controls exposed in the panel, and the shape that gets
 * persisted per-project and sent back and forth to the webview.
 */
export interface UiState {
  /** Current file attachment patterns. */
  attach: string;
  exclude: string;
  clipboard: boolean;
  projectStructure: boolean;
  diffFormat: boolean;
  files: boolean;
  promptTail: boolean;
  outputFile: string;
}

export function defaultUiState(): UiState {
  return {
    attach: "",
    exclude: "",
    clipboard: true,
    projectStructure: true,
    diffFormat: true,
    files: true,
    promptTail: true,
    outputFile: "",
  };
}

export interface GenerateResult {
  markdown: string;
  allFiles: string[];
  attachedFiles: string[];
}

/** Messages sent from the extension host to the webview. */
export type HostToWebviewMessage =
  | {
      type: "init";
      state: UiState;
      hasWorkspace: boolean;
      canUndo: boolean;
      canRedo: boolean;
      labels: boolean;
    }
  | {
      type: "runResult";
      ok: true;
      fileCount: number;
      copiedToClipboard: boolean;
      writtenToFile: boolean;
      searchCount?: number;
      searchResultCount?: number;
    }
  | { type: "runResult"; ok: false; error: string }
  | {
      type: "applyResult";
      ok: true;
      modified: number;
      created: number;
      deleted: number;
      fuzzy: number;
      alreadyApplied?: boolean;
    }
  | { type: "applyResult"; ok: false; error: string }
  | {
      type: "undoResult";
      ok: true;
      modified: number;
      created: number;
      deleted: number;
    }
  | { type: "undoResult"; ok: false; error: string }
  | {
      type: "redoResult";
      ok: true;
      modified: number;
      created: number;
      deleted: number;
    }
  | { type: "redoResult"; ok: false; error: string }
  | { type: "undoRedoState"; canUndo: boolean; canRedo: boolean }
  | { type: "suggestResult"; requestId: number; items: string[] }
  | {
      type: "highlightResult";
      requestId: number;
      attach: boolean[];
      exclude: boolean[];
    };

/** Messages sent from the webview to the extension host. */
export type WebviewToHostMessage =
  | { type: "stateChanged"; state: UiState }
  | { type: "labelsChanged"; labels: boolean }
  | { type: "run"; state: UiState }
  | { type: "moreContext"; state: UiState }
  | { type: "applyDiffs" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "suggest"; requestId: number; prefix: string }
  | { type: "highlight"; requestId: number; attach: string; exclude: string };
