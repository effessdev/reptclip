export interface BuildMarkdownInput {
  allFiles: string[];
  includedFiles: string[];
  fileContents: Record<string, string>;
  includeStructure: boolean;
  includeDiffFormat: boolean;
  includeFiles: boolean;
  includePromptTail: boolean;
  /**
   * Per-file raw line counts to append next to each path in the "Project
   * structure" listing, e.g. `main.py (120)`. A path missing from the map
   * (or mapped to `undefined`) renders with no count, for binary/oversized
   * files. Leave the whole field `undefined` to turn the feature off
   * entirely — the explanatory sentence below the heading is then omitted
   * too.
   */
  lineCounts?: Record<string, number | undefined>;
}

// Instruction block appended after the project structure when the
// "AI instructions" checkbox is on. Lives in a markdown file so the inline
// code spans and the 3-/4-backtick fences can be edited as raw markdown
// without escaping. esbuild inlines it as a string at build time (see the
// `loader: { '.md': 'text' }` rule in esbuild.js), so nothing is read from
// disk at runtime and the file never ships separately to users.
import DIFF_FORMAT_SECTION from "./diff-format.md";

/**
 * Produces the same overall shape as the original CLI's output:
 *   # Project structure   (optional, full non-ignored tree)
 *   ## AI instructions    (optional, Search/Replace instructions)
 *   # <path>               (one section per included file)
 *   # Prompt                (optional tail)
 */
export function buildMarkdown(input: BuildMarkdownInput): string {
  const parts: string[] = [];

  if (input.includeStructure) {
    const lines = input.lineCounts
      ? input.allFiles.map((file) => {
          const count = input.lineCounts![file];
          return count === undefined ? file : `${file} (${count})`;
        })
      : input.allFiles;
    const heading = input.lineCounts
      ? "# Project structure\n\nThe number in parentheses after a file is its raw line count (including blank lines); binary or unreadable files are listed without one."
      : "# Project structure";
    parts.push(`${heading}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\``);
  }

  if (input.includeDiffFormat) {
    parts.push(DIFF_FORMAT_SECTION);
  }

  if (input.includeFiles) {
    for (const file of input.includedFiles) {
      const content = input.fileContents[file] ?? "";
      parts.push(`# ${file}\n\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  if (input.includePromptTail) {
    parts.push("# Prompt");
  }

  const body = parts.join("\n\n").trimEnd();
  return input.includePromptTail ? body + "\n\n" : body + "\n";
}
