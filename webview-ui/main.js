// Runs inside the webview sandbox. Talks to the extension host purely via
// postMessage — no direct filesystem/clipboard access from here.
(function () {
  const vscode = acquireVsCodeApi();

  const els = {
    attach: document.getElementById("attach"),
    exclude: document.getElementById("exclude"),
    patternPair: document.getElementById("pattern-pair"),
    attachSection: document.getElementById("attach-section"),
    excludeSection: document.getElementById("exclude-section"),
    clipboard: document.getElementById("clipboard"),
    labels: document.getElementById("labels"),
    structure: document.getElementById("structure"),
    diffFormat: document.getElementById("diffFormat"),
    files: document.getElementById("files"),
    promptTail: document.getElementById("promptTail"),
    output: document.getElementById("output"),
    runBtn: document.getElementById("runBtn"),
    applyBtn: document.getElementById("applyBtn"),
    moreContextBtn: document.getElementById("moreContextBtn"),
    undoBtn: document.getElementById("undoBtn"),
    redoBtn: document.getElementById("redoBtn"),
    status: document.getElementById("status"),
    warning: document.getElementById("warning"),
    suggest: document.getElementById("suggest"),
    attachBackdrop: document.getElementById("attach-backdrop"),
    excludeBackdrop: document.getElementById("exclude-backdrop"),
  };

  // The attach/exclude boxes drive autocomplete; the output box does not.
  const patternFields = [els.attach, els.exclude];

  // --- Token highlighting -------------------------------------------------
  // Textareas can't color individual tokens, so a read-only "backdrop" div
  // sits behind each one (with transparent textarea text on top) and mirrors
  // its content with a colored span per pattern token. A token turns green
  // when it matches at least one file, yellow when it matches none.
  const editors = new Map([
    [
      els.attach,
      { key: "attach", input: els.attach, backdrop: els.attachBackdrop },
    ],
    [
      els.exclude,
      { key: "exclude", input: els.exclude, backdrop: els.excludeBackdrop },
    ],
  ]);

  const highlightState = {
    requestId: 0,
    flags: { attach: [], exclude: [] },
  };

  function escapeHtml(s) {
    return s.replace(/[&<>]/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
    );
  }

  // Mirrors the extension host's tokenizer: whitespace separates tokens and
  // quotes let a token contain spaces (quotes stripped from the returned text).
  // Also records each token's raw [start, end) range so the backdrop can wrap
  // the exact typed characters (quotes included) in a colored span. Keeping
  // this in lockstep with the host guarantees flag indices line up.
  function scanTokens(input) {
    const tokens = [];
    let i = 0;
    let start = -1;
    let text = "";
    const flush = (end) => {
      if (start !== -1 && text.length > 0) {
        tokens.push({ start, end, text });
      }
      start = -1;
      text = "";
    };
    while (i < input.length) {
      const ch = input[i];
      if (ch === '"' || ch === "'") {
        if (start === -1) {
          start = i;
        }
        let j = i + 1;
        while (j < input.length && input[j] !== ch) {
          text += input[j];
          j++;
        }
        i = j + 1; // skip the closing quote (or run past EOF)
        continue;
      }
      if (/\s/.test(ch)) {
        flush(i);
        i++;
        continue;
      }
      if (start === -1) {
        start = i;
      }
      text += ch;
      i++;
    }
    flush(input.length);
    return tokens;
  }

  function renderBackdrop(editor) {
    const { input, backdrop, key } = editor;
    if (!backdrop) {
      return;
    }
    const flags = highlightState.flags[key];
    const tokens = scanTokens(input.value);
    let html = "";
    let pos = 0;
    tokens.forEach((t, idx) => {
      html += escapeHtml(input.value.slice(pos, t.start));
      const cls =
        idx < flags.length ? (flags[idx] ? "hl-match" : "hl-nomatch") : "";
      const body = escapeHtml(input.value.slice(t.start, t.end));
      html += cls ? `<span class="${cls}">${body}</span>` : body;
      pos = t.end;
    });
    html += escapeHtml(input.value.slice(pos));
    backdrop.innerHTML = html;
    backdrop.scrollTop = input.scrollTop;
  }

  function requestHighlight() {
    const requestId = ++highlightState.requestId;
    vscode.postMessage({
      type: "highlight",
      requestId,
      attach: els.attach.value,
      exclude: els.exclude.value,
    });
  }
  const requestHighlightDebounced = debounce(requestHighlight, 200);

  const completion = {
    el: null, // textarea the dropdown is attached to
    items: [], // current suggestion strings
    index: -1, // highlighted item
    start: 0, // cursor offset where the active token began
    requestId: 0, // guards against out-of-order suggestResult replies
  };

  function currentState() {
    return {
      attach: els.attach.value,
      exclude: els.exclude.value,
      clipboard: els.clipboard.checked,
      projectStructure: els.structure.checked,
      diffFormat: els.diffFormat.checked,
      files: els.files.checked,
      promptTail: els.promptTail.checked,
      outputFile: els.output.value,
    };
  }

  function isSideBySideLayout() {
    return !window.matchMedia("(max-width: 700px)").matches;
  }

  function getPatternFieldMinHeight(field) {
    const styles = window.getComputedStyle(field);
    const lineHeight =
      parseFloat(styles.lineHeight) || parseFloat(styles.fontSize) * 1.5;
    const paddingTop = parseFloat(styles.paddingTop) || 0;
    const paddingBottom = parseFloat(styles.paddingBottom) || 0;
    const borderTop = parseFloat(styles.borderTopWidth) || 0;
    const borderBottom = parseFloat(styles.borderBottomWidth) || 0;

    return Math.ceil(
      lineHeight * 2 + paddingTop + paddingBottom + borderTop + borderBottom,
    );
  }

  function resizePatternField(field) {
    if (!field) {
      return;
    }

    field.style.height = "auto";
    const minHeight = getPatternFieldMinHeight(field);
    const nextHeight = Math.max(minHeight, field.scrollHeight);
    field.style.height = `${nextHeight}px`;
  }

  function syncPatternFieldHeights() {
    if (!els.attach || !els.exclude) {
      return;
    }

    els.attach.style.height = "auto";
    els.exclude.style.height = "auto";

    if (isSideBySideLayout()) {
      const sharedHeight = Math.max(
        getPatternFieldMinHeight(els.attach),
        els.attach.scrollHeight,
        getPatternFieldMinHeight(els.exclude),
        els.exclude.scrollHeight,
      );
      els.attach.style.height = `${sharedHeight}px`;
      els.exclude.style.height = `${sharedHeight}px`;
      return;
    }

    resizePatternField(els.attach);
    resizePatternField(els.exclude);
  }

  function debounce(fn, waitMs) {
    let timer;
    const wrapped = (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), waitMs);
    };
    // Run a pending call immediately (used when the view is about to hide).
    wrapped.flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
        fn();
      }
    };
    return wrapped;
  }

  function persist() {
    vscode.postMessage({ type: "stateChanged", state: currentState() });
  }
  const persistDebounced = debounce(persist, 300);

  function setStatus(text, isError = false) {
    els.status.textContent = text;
    els.status.classList.toggle("status--error", isError);
  }

  // Compact token count for the status line, e.g. 1234 -> "1.2k", 950 -> "950".
  function formatTokenCount(count) {
    if (count < 1000) {
      return String(count);
    }
    const thousands = count / 1000;
    // Trim a trailing ".0" so exact thousands read as "2k" rather than "2.0k".
    return `${thousands.toFixed(1).replace(/\.0$/, "")}k`;
  }

  function updateFileControlsVisibility() {
    const shouldShow = els.files.checked;
    els.patternPair.hidden = !shouldShow;
    els.attachSection.hidden = !shouldShow;
    els.excludeSection.hidden = !shouldShow;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function run() {
    setStatus("Working…");
    vscode.postMessage({ type: "run", state: currentState() });
  }

  // The host reads the clipboard (the webview sandbox has no clipboard
  // access) and applies the Search/Replace blocks it finds there.
  function applyFromClipboard() {
    setStatus("Applying…");
    vscode.postMessage({ type: "applyDiffs" });
  }

  function undo() {
    setStatus("Undoing…");
    vscode.postMessage({ type: "undo" });
  }

  function redo() {
    setStatus("Redoing…");
    vscode.postMessage({ type: "redo" });
  }

  // The host reads cat/grep commands from the clipboard, embeds the named
  // files, runs the searches, and honors the same output options as "Context".
  function moreContextFromClipboard() {
    setStatus("Working…");
    vscode.postMessage({ type: "moreContext", state: currentState() });
  }

  // --- Autocomplete -------------------------------------------------------

  // Returns the token under the caret: where it starts and the prefix typed so
  // far. A token is bounded by whitespace or a quote on either side.
  function tokenAtCursor(el) {
    const text = el.value;
    const cursor = el.selectionStart;
    let i = cursor - 1;
    while (i >= 0 && !/[\s"']/.test(text[i])) {
      i--;
    }
    return { start: i + 1, prefix: text.slice(i + 1, cursor) };
  }

  function hideSuggestions() {
    els.suggest.hidden = true;
    completion.items = [];
    completion.index = -1;
    completion.el = null;
  }

  function requestSuggestions(el) {
    const { start, prefix } = tokenAtCursor(el);
    completion.el = el;
    completion.start = start;

    if (!prefix) {
      hideSuggestions();
      return;
    }

    const requestId = ++completion.requestId;
    vscode.postMessage({ type: "suggest", requestId, prefix });
  }
  const requestSuggestionsDebounced = debounce(requestSuggestions, 120);

  // Splits a candidate path into its directory prefix and final segment so
  // the dropdown can de-emphasize the folder part (matters now that
  // suggestions can match by file name deep in the tree).
  function splitPath(item) {
    const cut = item.endsWith("/") ? item.length - 1 : item.length;
    const slash = item.lastIndexOf("/", cut - 1);
    return slash === -1
      ? { dir: "", name: item }
      : { dir: item.slice(0, slash + 1), name: item.slice(slash + 1) };
  }

  function renderSuggestions(items) {
    const el = completion.el;
    if (!el) {
      return;
    }

    completion.items = items;
    completion.index = items.length > 0 ? 0 : -1;

    while (els.suggest.firstChild) {
      els.suggest.removeChild(els.suggest.firstChild);
    }
    items.forEach((item, idx) => {
      const isFolder = item.endsWith("/");
      const row = document.createElement("div");
      row.className = "item" + (idx === completion.index ? " active" : "");
      row.setAttribute("role", "option");

      const label = document.createElement("span");
      const { dir, name } = splitPath(item);
      if (dir) {
        const dirSpan = document.createElement("span");
        dirSpan.className = "dir";
        dirSpan.textContent = dir;
        label.appendChild(dirSpan);
      }
      const nameSpan = document.createElement("span");
      nameSpan.className = "name";
      nameSpan.textContent = name;
      label.appendChild(nameSpan);

      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = isFolder ? "folder" : "file";

      row.append(label, kind);
      // mousedown (not click) so it fires before the textarea loses focus.
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        acceptSuggestion(idx);
      });
      els.suggest.appendChild(row);
    });

    if (items.length === 0) {
      hideSuggestions();
      return;
    }

    positionSuggestions(el);
    els.suggest.hidden = false;
  }

  function positionSuggestions(el) {
    const rect = el.getBoundingClientRect();
    els.suggest.style.left = `${rect.left + window.scrollX}px`;
    els.suggest.style.top = `${rect.bottom + window.scrollY + 2}px`;
    els.suggest.style.width = `${rect.width}px`;
  }

  function highlight(index) {
    const rows = els.suggest.querySelectorAll(".item");
    if (rows.length === 0) {
      return;
    }
    completion.index = (index + rows.length) % rows.length;
    rows.forEach((row, i) =>
      row.classList.toggle("active", i === completion.index),
    );
    rows[completion.index].scrollIntoView({ block: "nearest" });
  }

  function acceptSuggestion(index = completion.index) {
    const el = completion.el;
    const item = completion.items[index];
    if (!el || item === undefined) {
      return;
    }

    const accepted = item.endsWith("/") ? item : `${item} `;
    const text = el.value;
    const caret = el.selectionStart;
    const before = text.slice(0, completion.start);
    const after = text.slice(caret);
    const newValue = before + accepted + after;

    el.value = newValue;
    const newCaret = completion.start + accepted.length;
    el.focus();
    el.setSelectionRange(newCaret, newCaret);

    persist();
    hideSuggestions();
    renderBackdrop(editors.get(el));
    syncPatternFieldHeights();
    requestHighlightDebounced();

    // Choosing a folder should immediately offer its contents; files add a
    // separating space so the next token starts cleanly.
    if (item.endsWith("/")) {
      requestSuggestions(el);
    }
  }

  // --- Event wiring -------------------------------------------------------

  patternFields.forEach((el) => {
    el.addEventListener("input", () => {
      persistDebounced();
      requestSuggestionsDebounced(el);
      renderBackdrop(editors.get(el));
      syncPatternFieldHeights();
      requestHighlightDebounced();
    });

    // Enter runs the task; Shift+Enter inserts a newline. While the dropdown is
    // open, arrows navigate and Enter/Tab accept instead of running.
    el.addEventListener("keydown", (event) => {
      const open = !els.suggest.hidden && completion.items.length > 0;

      if (open && event.key === "ArrowDown") {
        event.preventDefault();
        highlight(completion.index + 1);
        return;
      }
      if (open && event.key === "ArrowUp") {
        event.preventDefault();
        highlight(completion.index - 1);
        return;
      }
      if (open && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        acceptSuggestion();
        return;
      }
      if (open && event.key === "Escape") {
        event.preventDefault();
        hideSuggestions();
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        run();
      }
    });

    el.addEventListener("blur", () => {
      // Give a pending mousedown on a row a chance to fire first.
      setTimeout(hideSuggestions, 120);
    });

    // Keep the backdrop aligned when the textarea scrolls internally.
    el.addEventListener("scroll", () => {
      const editor = editors.get(el);
      if (editor && editor.backdrop) {
        editor.backdrop.scrollTop = el.scrollTop;
      }
    });
  });

  const divider = document.querySelector(".pattern-divider");
  let isResizing = false;

  if (divider) {
    divider.addEventListener("pointerdown", (event) => {
      if (window.matchMedia("(max-width: 700px)").matches) {
        return;
      }
      isResizing = true;
      event.preventDefault();
      divider.setPointerCapture?.(event.pointerId);
    });
  }

  window.addEventListener("pointermove", (event) => {
    if (!isResizing || !els.patternPair) {
      return;
    }

    const rect = els.patternPair.getBoundingClientRect();
    const split = clamp(
      ((event.clientX - rect.left) / rect.width) * 100,
      25,
      75,
    );
    els.patternPair.style.setProperty("--pattern-split", `${split}%`);
  });

  window.addEventListener("pointerup", () => {
    isResizing = false;
  });

  window.addEventListener("resize", syncPatternFieldHeights);

  els.output.addEventListener("input", persistDebounced);
  [
    els.clipboard,
    els.structure,
    els.diffFormat,
    els.files,
    els.promptTail,
  ].forEach((el) => {
    el.addEventListener("change", persist);
  });
  els.labels.addEventListener("change", () => {
    document.body.classList.toggle("hide-labels", !els.labels.checked);
    vscode.postMessage({ type: "labelsChanged", labels: els.labels.checked });
  });
  els.files.addEventListener("change", () => {
    updateFileControlsVisibility();
    persist();
  });

  els.runBtn.addEventListener("click", run);
  els.moreContextBtn.addEventListener("click", moreContextFromClipboard);
  els.applyBtn.addEventListener("click", applyFromClipboard);
  els.undoBtn.addEventListener("click", undo);
  els.redoBtn.addEventListener("click", redo);

  // Switching to another tab in the bottom panel fires a visibilitychange
  // before dynamic content is suspended — flush any debounced save so edits
  // typed right before the switch are never lost.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      persistDebounced.flush();
    }
  });

  window.addEventListener("message", (event) => {
    const message = event.data;

    if (message.type === "init") {
      const s = message.state;
      els.attach.value = s.attach ?? "";
      els.exclude.value = s.exclude ?? "";
      els.clipboard.checked = !!s.clipboard;
      els.structure.checked = !!s.projectStructure;
      els.diffFormat.checked = !!s.diffFormat;
      els.files.checked = s.files !== undefined ? !!s.files : true;
      els.promptTail.checked = !!s.promptTail;
      els.output.value = s.outputFile ?? "";
      els.labels.checked =
        message.labels !== undefined ? !!message.labels : true;
      document.body.classList.toggle("hide-labels", !els.labels.checked);
      updateFileControlsVisibility();
      syncPatternFieldHeights();
      els.warning.hidden = message.hasWorkspace;
      els.runBtn.disabled = !message.hasWorkspace;
      els.moreContextBtn.disabled = !message.hasWorkspace;
      els.applyBtn.disabled = !message.hasWorkspace;
      els.undoBtn.disabled = !message.hasWorkspace || !message.canUndo;
      els.redoBtn.disabled = !message.hasWorkspace || !message.canRedo;
      editors.forEach(renderBackdrop);
      if (message.hasWorkspace) {
        requestHighlight();
      }
      return;
    }

    if (message.type === "highlightResult") {
      if (message.requestId === highlightState.requestId) {
        highlightState.flags.attach = message.attach ?? [];
        highlightState.flags.exclude = message.exclude ?? [];
        editors.forEach(renderBackdrop);
      }
      return;
    }

    if (message.type === "suggestResult") {
      if (message.requestId === completion.requestId) {
        renderSuggestions(message.items);
      }
      return;
    }

    if (message.type === "moreContextProgress") {
      setStatus(`Searching… ${message.percent}%`);
      return;
    }

    if (message.type === "runResult") {
      if (message.ok) {
        const destinationStatus =
          message.copiedToClipboard && message.writtenToFile
            ? "Context copied to clipboard and written to file"
            : message.copiedToClipboard
              ? "Context copied to clipboard"
              : message.writtenToFile
                ? "Context written to file"
                : "Context generated but not written anywhere (please enable Copy to clipboard or specify Ouput file path)";

        const tokenSuffix =
          message.tokenCount !== undefined
            ? ` ~${formatTokenCount(message.tokenCount)} token(s).`
            : "";

        const structureSuffix =
          message.structureFileCount !== undefined
            ? ` ${message.structureFileCount} file(s) in Project structure.`
            : "";

        setStatus(
          message.searchCount === undefined
            ? message.fileCount === 0
              ? `${destinationStatus}. No files attached.${structureSuffix}${tokenSuffix}`
              : `${destinationStatus}. ${message.fileCount} file(s) attached.${structureSuffix}${tokenSuffix}`
            : `${destinationStatus}. ${message.fileCount} file(s) attached, ${message.searchCount} search(es) run, ${message.searchResultCount ?? 0} result(s) found.${structureSuffix}${tokenSuffix}`,
        );
      } else {
        setStatus(`Error: ${message.error}`, true);
      }
    }

    if (message.type === "applyResult") {
      if (message.ok) {
        setStatus(
          message.alreadyApplied
            ? "This diff was already applied."
            : `Applied: ${message.modified} modified, ${message.created} created, ${message.deleted} deleted${message.fuzzy ? `, ${message.fuzzy} fuzzy` : ""}.`,
        );
      } else {
        setStatus(`Not applied. No files were changed. ${message.error}`, true);
      }
    }

    if (message.type === "undoResult") {
      if (message.ok) {
        setStatus(
          `Undone: ${message.modified} modified, ${message.created} created, ${message.deleted} deleted.`,
        );
      } else {
        setStatus(message.error, message.error !== "Nothing to undo.");
      }
    }

    if (message.type === "redoResult") {
      if (message.ok) {
        setStatus(
          `Redone: ${message.modified} modified, ${message.created} created, ${message.deleted} deleted.`,
        );
      } else {
        setStatus(message.error, message.error !== "Nothing to redo.");
      }
    }

    if (message.type === "undoRedoState") {
      const hasWorkspace = !els.runBtn.disabled;
      els.undoBtn.disabled = !hasWorkspace || !message.canUndo;
      els.redoBtn.disabled = !hasWorkspace || !message.canRedo;
    }
  });
})();
