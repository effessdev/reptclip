"""Glob-based include/exclude filtering of file paths.

Only two wildcard tokens are supported, matching the CLI's documented syntax:

- ``*``  matches any run of characters except ``/`` (a single path segment).
- ``**`` matches any number of characters, including ``/`` (any depth).

A pattern ending in ``/`` (e.g. ``docs/``) is treated as shorthand for
``docs/**``, i.e. "everything inside this directory, recursively".
"""

from __future__ import annotations

import re

# Placeholders used while building the regex so that literal `*` characters
# in the original pattern can't collide with the substitution logic.
_DOUBLE_STAR_SLASH = "\x00DOUBLESTAR_SLASH\x00"
_DOUBLE_STAR = "\x00DOUBLESTAR\x00"
_STAR = "\x00STAR\x00"


def _glob_to_regex(pattern: str) -> re.Pattern[str]:
    """Compile a single glob pattern into a regex matching a relative path."""
    if pattern.endswith("/"):
        pattern += "**"

    # Order matters: swap out "**/" before "**" before "*".
    working = pattern.replace("**/", _DOUBLE_STAR_SLASH)
    working = working.replace("**", _DOUBLE_STAR)
    working = working.replace("*", _STAR)

    escaped = re.escape(working)
    escaped = escaped.replace(re.escape(_DOUBLE_STAR_SLASH), "(?:.*/)?")
    escaped = escaped.replace(re.escape(_DOUBLE_STAR), ".*")
    escaped = escaped.replace(re.escape(_STAR), "[^/]*")

    return re.compile(f"^{escaped}$")


def matches_any(path: str, patterns: list[str]) -> bool:
    """Return True if `path` matches at least one glob pattern in `patterns`."""
    normalized = path.replace("\\", "/")
    return any(_glob_to_regex(pattern).match(normalized) for pattern in patterns)


def filter_files(
    files: list[str],
    include_patterns: list[str],
    exclude_patterns: list[str],
) -> list[str]:
    """Return the subset of `files` selected by include/exclude glob patterns.

    No file is selected unless it matches at least one include pattern
    (there is no "include everything by default" behaviour). Files matching
    any exclude pattern are then removed from that set.
    """
    if not include_patterns:
        return []

    included = [f for f in files if matches_any(f, include_patterns)]
    if not exclude_patterns:
        return included

    return [f for f in included if not matches_any(f, exclude_patterns)]
