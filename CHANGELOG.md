## v2.2.0

- Split `grep` searches in "More Context" into batches by file size so the 15-second bound applies to the whole search instead of being an all-or-nothing cliff: progress is reported as a percentage while it runs, and if time runs out mid-search you're asked whether to keep going, which doubles the remaining time and resumes from the batch that was in flight — nothing already found is lost or re-searched.
- Read `.reptclipignore` files as an additional exclusion source: same syntax and anchoring as `.gitignore`, layered per directory, able to re-include its own rules and never able to re-include a file git ignores. Editing the file asks for confirmation, like `.gitignore`. (by [ManSio](https://github.com/ManSio))
- Keep the files of a workspace folder that a `.gitignore` above it re-includes (`/nested/build/` in the root, `!build/` in `nested/`), instead of treating the whole workspace as ignored. (by [ManSio](https://github.com/ManSio))
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
