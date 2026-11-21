import micromatch from "micromatch";

/**
 * Given every non-gitignored file (relative, posix-style paths) and a set
 * of attach/exclude patterns, returns the files that should be embedded
 * in the generated Markdown. Include patterns are applied first, then
 * exclude patterns narrow that result — matching the original CLI's
 * documented precedence.
 *
 * A file "belongs" to the *last* include pattern that matches it, so later
 * (more specific) patterns push their files toward the end of the result —
 * closer to the Prompt section. Within each pattern group, matches are
 * sorted alphabetically for determinism.
 */
export function selectFiles(
  allFiles: string[],
  attachPatterns: string[],
  excludePatterns: string[],
): string[] {
  if (attachPatterns.length === 0) {
    return [];
  }

  const matchesPerPattern = attachPatterns.map((pattern) =>
    micromatch(allFiles, [pattern], { dot: true, nocase: false }).sort(),
  );

  const lastPatternIndex = new Map<string, number>();
  matchesPerPattern.forEach((matches, index) => {
    for (const file of matches) {
      lastPatternIndex.set(file, index);
    }
  });

  const selected: string[] = [];
  matchesPerPattern.forEach((matches, index) => {
    for (const file of matches) {
      if (lastPatternIndex.get(file) === index) {
        selected.push(file);
      }
    }
  });

  if (excludePatterns.length > 0) {
    const excluded = new Set(
      micromatch(allFiles, excludePatterns, { dot: true, nocase: false }),
    );
    return selected.filter((f) => !excluded.has(f));
  }

  return selected;
}

/**
 * Whether a single pattern matches at least one of the given files. Used by
 * the panel to color each attach/exclude token (green = hits something,
 * yellow = matches nothing). Applies the same micromatch options as
 * `selectFiles` so the highlighting never disagrees with an actual run.
 */
export function matchesAnyFile(allFiles: string[], pattern: string): boolean {
  return (
    micromatch(allFiles, [pattern], { dot: true, nocase: false }).length > 0
  );
}
