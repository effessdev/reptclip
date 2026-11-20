import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("panel keeps include/exclude inputs in a responsive split layout", () => {
  const repoRoot = resolve(__dirname, "..", "..");
  const html = readFileSync(
    resolve(repoRoot, "src", "panel", "getHtml.ts"),
    "utf8",
  );
  const css = readFileSync(
    resolve(repoRoot, "webview-ui", "style.css"),
    "utf8",
  );
  const webviewJs = readFileSync(
    resolve(repoRoot, "webview-ui", "main.js"),
    "utf8",
  );

  assert.match(html, /pattern-pair/);
  assert.match(html, /pattern-divider/);
  assert.match(css, /pattern-pair/);
  assert.match(css, /pattern-divider/);
  assert.match(css, /@media\s*\(max-width:\s*700px\)/i);
  assert.match(css, /resize:\s*none/i);
  assert.match(css, /min-height:\s*calc\(/i);
  assert.match(webviewJs, /matchMedia\s*\(\s*"\(max-width:\s*700px\)"\s*\)/i);
  assert.match(
    webviewJs,
    /style\.height\s*=\s*"auto"|scrollHeight|Math\.max\s*\(|style\.height\s*=\s*`\$\{\s*.*\s*\}px`/i,
  );
  assert.doesNotMatch(css, /resize:\s*vertical/i);
  assert.match(webviewJs, /No files attached\./);
  assert.match(webviewJs, /Context copied to clipboard/);
  assert.match(webviewJs, /Context written to file/);
  assert.match(webviewJs, /copiedToClipboard && message\.writtenToFile/);
  assert.match(webviewJs, /file\(s\) included/);
});
