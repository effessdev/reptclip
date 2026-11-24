/**
 * Fenced-code-block helpers shared by every Markdown producer in the
 * extension. A file's content can legitimately contain a run of backticks
 * (a README with an example, a nested code block, a diff of a diff), and in
 * CommonMark a line of backticks at least as long as the opening fence closes
 * it. So the fence has to be built from the content, never hardcoded.
 */
export function fenceFor(body: string): string {
  const longestRun = (body.match(/`+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  return "`".repeat(Math.max(3, longestRun + 1));
}

/**
 * One Markdown section: a heading followed by `body` inside a safe fence.
 * `trimTrailing` is for callers that render a command/result block; embedded
 * file content is passed verbatim so its trailing newlines survive.
 */
export function fencedSection(
  heading: string,
  body: string,
  trimTrailing: boolean = true,
): string {
  const text = trimTrailing ? body.trimEnd() : body;
  const fence = fenceFor(text);
  return `## ${heading}\n\n${fence}\n${text}\n${fence}`;
}
