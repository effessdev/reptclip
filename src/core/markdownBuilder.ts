export interface BuildMarkdownInput {
  allFiles: string[];
  includedFiles: string[];
  fileContents: Record<string, string>;
  includeStructure: boolean;
  includeDiffFormat: boolean;
  includeFiles: boolean;
  includePromptTail: boolean;
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
    parts.push(
      `# Project structure\n\n\`\`\`\n${input.allFiles.join("\n")}\n\`\`\``,
    );
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
