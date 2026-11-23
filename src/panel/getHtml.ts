import * as vscode from "vscode";

export function getHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "webview-ui", "main.js"),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "webview-ui", "style.css"),
  );
  const nonce = getNonce();

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
  />
  <link href="${styleUri}" rel="stylesheet" />
  <title>ReptClip</title>
</head>
<body>
  <div class="content">
    <div id="warning" class="warning" hidden>Open a folder to use ReptClip.</div>

    <section class="section checkboxes">
      <label class="hideable-label">Sections to include in the context</label>
      <label class="checkbox">
        <input type="checkbox" id="structure" />
        <span>Project structure</span>
      </label>
      <label class="checkbox">
        <input type="checkbox" id="diffFormat" />
        <span>AI instructions</span>
      </label>
      <label class="checkbox">
        <input type="checkbox" id="files" />
        <span>Files</span>
      </label>
      <label class="checkbox">
        <input type="checkbox" id="promptTail" />
        <span>Prompt section</span>
      </label>
    </section>

    <div id="pattern-pair" class="pattern-pair">
      <section id="attach-section" class="section pattern-column pattern-column--attach">
        <label for="attach" class="hideable-label">Files to attach (separated by spaces, glob patterns supported)</label>
        <div class="pattern-editor">
          <div id="attach-backdrop" class="pattern-backdrop" aria-hidden="true"></div>
          <textarea
            id="attach"
            rows="2"
            spellcheck="false"
            placeholder='AGENTS.md src/**/*.py "name with space.md"'
          ></textarea>
        </div>
      </section>

      <div class="pattern-divider" aria-hidden="true" title="Drag to resize attach/exclude columns"></div>

      <section id="exclude-section" class="section pattern-column pattern-column--exclude">
        <label for="exclude" class="hideable-label">Files to exclude from attached files</label>
        <div class="pattern-editor">
          <div id="exclude-backdrop" class="pattern-backdrop" aria-hidden="true"></div>
          <textarea
            id="exclude"
            rows="2"
            spellcheck="false"
            placeholder="src/secret.py"
          ></textarea>
        </div>
      </section>
    </div>

    <section class="section">
      <label for="output" class="hideable-label">Output file</label>
      <input type="text" id="output" spellcheck="false" placeholder="out.md" />
    </section>

    <section class="section checkboxes">
      <label class="hideable-label">Other settings</label>
      <label class="checkbox">
        <input type="checkbox" id="clipboard" />
        <span>Copy to clipboard</span>
      </label>
      <label class="checkbox">
        <input type="checkbox" id="labels" />
        <span>Show labels</span>
      </label>
    </section>
  </div>

  <div class="actions">
    <button id="runBtn" type="button">Context</button>
    <button id="moreContextBtn" type="button" title="Run cat/grep commands from the clipboard to embed files and search the project">More Context</button>
    <button id="applyBtn" type="button" title="Read Search/Replace blocks from the clipboard and apply them to the workspace">Apply Diffs</button>
    <span id="status" class="status" aria-live="polite">Click "Context" or press Enter inside an input to copy</span>
    <span class="undo-redo-group">
      <button id="undoBtn" type="button" title="Undo the last applied diff" aria-label="Undo" disabled>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="1 4 1 10 7 10"></polyline>
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
        </svg>
      </button>
      <button id="redoBtn" type="button" title="Redo the last undone diff" aria-label="Redo" disabled>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10"></polyline>
          <path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"></path>
        </svg>
      </button>
    </span>
  </div>

  <div id="suggest" class="suggest" role="listbox" hidden></div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
