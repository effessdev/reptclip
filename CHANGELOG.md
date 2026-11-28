## v2.2.0

- Fix the Markdown fence sizing so an attached file containing a ` ``` ` line can no longer close its section early and turn the rest of the file into active Markdown, embed file contents verbatim in both "Context" and "More Context" without trimming trailing whitespace, enforce strict UTF-8 decoding with a full-buffer NUL scan (including in`grep`results) instead of silently inserting replacement characters, and block catastrophic backtracking (ReDoS) in`grep` with a linear-time nested-quantifier scanner. (by [ManSio](https://github.com/ManSio))
- Serialize Apply, Undo and Redo per repository behind a single queue, so two overlapping operations on the same project can no longer both report success while one edit is lost, and Undo/Redo can no longer pop a stack the other was still filling. The queue key is the directory's real path plus the repository root rather than the spelling typed in the editor, while files, storage keys and buffer lookups keep using the path as opened. (by [ManSio](https://github.com/ManSio))
- Read files for the first "Context" click — both for the project-structure line counts and the embedded content — through a bounded pool of 32 concurrent reads instead of one file at a time, while keeping results in file order and the line-count/content pairing exact. Cuts a synthetic 2,000-file tree from ~3s to ~0.6s. Closes #13. (by [ManSio](https://github.com/ManSio))
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
