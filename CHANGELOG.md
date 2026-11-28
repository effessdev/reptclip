## v2.2.0

### Fix Markdown fence sizing and encoding safety (by [ManSio](https://github.com/ManSio))

Fixed the Markdown fence sizing so an attached file containing a ` ``` ` line can no longer close its section early and turn the rest of the file into active Markdown. File contents are now embedded verbatim in both "Context" and "More Context" without trimming trailing whitespace. Strict UTF-8 decoding is now enforced with a full-buffer NUL scan (including in `grep` results) instead of silently inserting replacement characters, and catastrophic backtracking (ReDoS) in `grep` is blocked with a linear-time nested-quantifier scanner.

### Serialize Apply, Undo, and Redo per repository (by [ManSio](https://github.com/ManSio))

Apply, Undo, and Redo are now serialized per repository behind a single queue, so two overlapping operations on the same project can no longer both report success while one edit is lost, and Undo/Redo can no longer pop a stack the other was still filling. The queue key is the directory's real path plus the repository root rather than the spelling typed in the editor, while files, storage keys, and buffer lookups keep using the path as opened.

### Parallelize file reads for "Context" (by [ManSio](https://github.com/ManSio))

Files are now read for the first "Context" click — both for the project-structure line counts and the embedded content — through a bounded pool of 32 concurrent reads instead of one file at a time, while keeping results in file order and the line-count/content pairing exact. Cuts a synthetic 2,000-file tree from ~3s to ~0.6s. Closes #13.

### Batch `grep` searches by file size

`grep` searches in "More Context" are now split into batches by file size so the 15-second bound applies to the whole search instead of being an all-or-nothing cliff. Progress is reported as a percentage while it runs, and if time runs out mid-search you're asked whether to keep going, which doubles the remaining time and resumes from the batch that was in flight — nothing already found is lost or re-searched.

### Support `.reptclipignore` files (by [ManSio](https://github.com/ManSio))

`.reptclipignore` files are now read as an additional exclusion source: same syntax and anchoring as `.gitignore`, layered per directory, able to re-include its own rules, and never able to re-include a file git ignores. Editing the file asks for confirmation, like `.gitignore`.

### Fix workspace folder re-inclusion (by [ManSio](https://github.com/ManSio))

Fixed keeping the files of a workspace folder that a `.gitignore` above it re-includes (`/nested/build/` in the root, `!build/` in `nested/`), instead of treating the whole workspace as ignored.

## v2.1.0

- Create "Other settings section". Add "Show labels" checkbox in "Other settings" (persisted globally, not project-wise). Move "Copy to clipboard" to "Other settings".
- Show estimated context token count in status after "Context" or "More Context" (cheap, chars/4).
- Add icon for ReptClip panel.
- Add sidebar support.

## v2.0.4 (2026-11-21)

No changelog entries recorded for this version and earlier versions.
