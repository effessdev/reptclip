import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(__dirname, "getHtml.ts"), "utf8");

test("output file field uses the same stacked-label layout as the other form fields", () => {
  assert.match(source, /<label\s+for="output">\s*Output file\s*<\/label>/s);
  assert.match(source, /<input\s+type="text"\s+id="output"/);
  assert.doesNotMatch(source, /<label[^>]*class="output-file"/);
});

test("provider reports status in the webview instead of VS Code notifications", () => {
  const provider = readFileSync(
    resolve(__dirname, "ReptclipViewProvider.ts"),
    "utf8",
  );

  assert.doesNotMatch(provider, /vscode\.window\.showErrorMessage/);
  assert.doesNotMatch(provider, /vscode\.window\.showInformationMessage/);
  assert.doesNotMatch(provider, /vscode\.window\.setStatusBarMessage/);
});
