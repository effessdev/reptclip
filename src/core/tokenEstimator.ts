/**
 * Rough token-count estimate for the generated Markdown, shown on the status
 * line. Uses the common ~4-characters-per-token rule of thumb. This is a
 * ballpark for display purposes, not an exact count for any particular
 * model's tokenizer — actual ratios vary by content (prose vs. code vs.
 * JSON), but a flat estimate is cheap and good enough for a status readout.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
