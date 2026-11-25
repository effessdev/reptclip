## v2.1.2

- Keep the files of a workspace folder that a `.gitignore` above it re-includes (`/nested/build/` in the root, `!build/` in `nested/`), instead of treating the whole workspace as ignored. (by [ManSio](https://github.com/ManSio))

## v2.1.1

- Size Markdown code fences dynamically to prevent attached files containing backtick lines from closing sections prematurely, and embed file contents verbatim without trimming trailing whitespace. (by [ManSio](https://github.com/ManSio))
- Enforce strict UTF-8 decoding and scan entire file buffers for NUL bytes to reject binary or non-UTF-8 files (including in `grep` results) instead of silently inserting replacement characters. (by [ManSio](https://github.com/ManSio))
- Block catastrophic backtracking (ReDoS) in `grep` with a linear-time nested-quantifier scanner. (by [ManSio](https://github.com/ManSio))

## v2.1.0

- Create "Other settings section". Add "Show labels" checkbox in "Other settings" (persisted globally, not project-wise). Move "Copy to clipboard" to "Other settings".
- Show estimated context token count in status after "Context" or "More Context" (cheap, chars/4).
- Add icon for ReptClip panel.
- Add sidebar support.

## v2.0.4 (2026-11-21)

No changelog entries recorded for this version and earlier versions.
