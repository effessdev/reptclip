import * as path from "path";
import { collectNonIgnoredFiles } from "./gitignoreScanner";

const MAX_SUGGESTIONS = 50;

// Score bands keep ordering predictable and hierarchical: a full-path prefix
// (folder browsing) always beats a basename prefix (typing a file name),
// which always beats a loose fuzzy hit. Realistic fuzzy scores stay far
// below BAND_BASENAME_PREFIX, so the bands never overlap.
const BAND_PATH_PREFIX = 1_000_000;
const BAND_BASENAME_PREFIX = 100_000;
const BAND_FOLDER_BONUS = 8;
const WORD_START_BONUS = 6;
const RUN_BONUS = 4;
const BASENAME_HIT_BONUS = 12;

interface CandidateEntry {
  candidate: string; // original display/match string
  lower: string; // full relative path, lowercased
  baseLower: string; // last path segment (folder name without slash), lowercased
}

/** Derived lowercased views over a candidate list, cached per array identity. */
const entryCache = new WeakMap<string[], CandidateEntry[]>();

function entriesFor(candidates: string[]): CandidateEntry[] {
  let entries = entryCache.get(candidates);
  if (!entries) {
    entries = candidates.map((candidate) => {
      const lower = candidate.toLowerCase();
      const bare = lower.endsWith("/") ? lower.slice(0, -1) : lower;
      const slash = bare.lastIndexOf("/");
      return {
        candidate,
        lower,
        baseLower: slash === -1 ? bare : bare.slice(slash + 1),
      };
    });
    entryCache.set(candidates, entries);
  }
  return entries;
}

/**
 * Greedy fzf-lite subsequence scorer: walks the query through `text` with
 * indexOf (early exit on the first missed character), rewarding consecutive
 * runs and word starts (after `/`, `.`, `-`, `_`). Returns null when the
 * query is not a subsequence of `text`.
 */
function fuzzyScore(text: string, query: string): number | null {
  let score = 0;
  let run = 0;
  let prev = -1;
  let firstAt = -1;

  for (let i = 0; i < query.length; i++) {
    const at = text.indexOf(query[i], prev + 1);
    if (at === -1) {
      return null;
    }
    if (at === prev + 1 && run > 0) {
      run += 1;
      score += run * RUN_BONUS;
    } else {
      run = 1;
      const before = at === 0 ? "/" : text[at - 1];
      if (
        before === "/" ||
        before === "." ||
        before === "-" ||
        before === "_"
      ) {
        score += WORD_START_BONUS;
      }
    }
    if (firstAt === -1) {
      firstAt = at;
    }
    prev = at;
  }

  // Prefer hits that start early in the text and short overall paths.
  score += Math.max(0, 24 - firstAt);
  score += Math.max(0, 40 - Math.floor(text.length / 2));
  return score;
}

/**
 * Scores one candidate against the lowercased query. Returns -1 for no
 * match, otherwise a value whose magnitude encodes the match band.
 */
function rankCandidate(entry: CandidateEntry, query: string): number {
  const folderBonus = entry.lower.endsWith("/") ? BAND_FOLDER_BONUS : 0;
  if (entry.lower.startsWith(query)) {
    // Ties stay alphabetical: the input array is pre-sorted and sort is stable.
    return BAND_PATH_PREFIX + folderBonus;
  }
  if (entry.baseLower.startsWith(query)) {
    // Within the name band, shallower (shorter) paths rank first.
    return (
      BAND_BASENAME_PREFIX + folderBonus + Math.max(0, 60 - entry.lower.length)
    );
  }

  const pathHit = fuzzyScore(entry.lower, query);
  const baseHit = fuzzyScore(entry.baseLower, query);
  const best = Math.max(
    pathHit ?? -1,
    baseHit === null ? -1 : baseHit + BASENAME_HIT_BONUS,
  );
  return best >= 0 ? best : -1;
}

/**
 * Builds the full set of completion candidates for the attach/exclude boxes:
 * every non-gitignored file path plus every parent directory (with a trailing
 * slash so the webview can offer folder navigation). All paths are relative to
 * `rootDir` and posix-style, matching what `generateContext` ultimately matches
 * against.
 */
export async function collectCandidates(rootDir: string): Promise<string[]> {
  const files = await collectNonIgnoredFiles(rootDir);
  const set = new Set<string>(files);

  for (const file of files) {
    let dir = path.posix.dirname(file);
    while (dir && dir !== "." && dir !== "/") {
      set.add(`${dir}/`);
      dir = path.posix.dirname(dir);
    }
  }

  return [...set].sort();
}

/**
 * Ranked, case-insensitive filter over pre-sorted candidates. Matches fall
 * into three bands (best first): full-path prefix, basename prefix, and
 * fuzzy subsequence anywhere in the path — so typing `clipboard.ts` surfaces
 * `src/core/clipboard.ts` without knowing its directory. Returns at most
 * `limit` matches, ties broken alphabetically (input is pre-sorted and
 * Array#sort is stable). An empty prefix yields no results on purpose.
 * Suggestions only appear once the user has started typing a token.
 */
export function filterCandidates(
  candidates: string[],
  prefix: string,
  limit: number = MAX_SUGGESTIONS,
): string[] {
  if (!prefix) {
    return [];
  }

  const query = prefix.toLowerCase();
  const scored: { candidate: string; score: number }[] = [];
  for (const entry of entriesFor(candidates)) {
    const score = rankCandidate(entry, query);
    if (score >= 0) {
      scored.push({ candidate: entry.candidate, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((hit) => hit.candidate);
}
