# ReptClip

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=effessdev.reptclip-for-vscode)
[![Open VSX](https://img.shields.io/badge/Open%20VSX-Registry-purple)](https://open-vsx.org/extension/effessdev/reptclip-for-vscode)

Paste your project as clean Markdown context into any free Chatbot, and apply the generated diffs in one click!

Watch the video demo below to see it in action 🔥

https://github.com/user-attachments/assets/7511352d-5db7-4e2f-8182-970405924406

## How it works (briefly)

Installing the extension adds a **ReptClip** tab to the bottom panel in VS Code. This is where everything happens:

<img width="1917" alt="ReptClip" src="https://github.com/user-attachments/assets/c12854f6-9928-483c-a95f-35e20cfb83e6" />

Zoomed in:

<img width="1787" alt="ReptClip zoomed in" src="https://github.com/user-attachments/assets/45770704-d55a-4e06-8fb8-6673bab8dd5b" />

To open the tab, press ``Ctrl + ` `` to open the bottom panel, then select **ReptClip**.

### Step 1: Copy context to clipboard

By default, the context consists of the **Project structure**, **AI instructions**, **attached files**, and an empty **Prompt** section to put your prompt. All in Markdown.

Use "Files to attach" text box to attach files to the context. You can use relative paths or glob patterns (e.g., `**/*.py` to add all Python files). You will get **live suggestion dropdowns** and **syntax highlighting** as you type. Press "Enter" or click the "Context" button to copy the context **straight to your clipboard**.

If no files are selected, ReptClip shows "No files attached." and keeps the remaining enabled context sections.

### Step 2: Paste context to your chatbot, along with your prompt

The chatbot will generate the diffs for you, according to the instructions provided in the context.

### Step 3: Apply the generated diffs

The chatbot outputs all diffs in a single code block covering line removals, additions, edits, and updates, file moves or renames, file creation, and file deletion. Copy the block and click **Apply Diffs** to apply the changes.

Didn't like it? Click the Undo button. Changed your mind? Click the Redo button!

### Optional step (before step 3): Add more context

If the chatbot wants to see more files or search the project, it will generate a code block containing the following custom commands:

- **`cat <path>`** To read a file.
- **`read-lines <path> <start_line> [end_line]`** To read sections of a file.
- **`grep <flags> <pattern> [paths...]`**: To search across the project with [grepts](https://github.com/ahmadawais/grepts).

You can copy that block and click the "More Context" button to copy the output to the clipboard, and paste it back to the chatbot.

### Key features

**The UI state is remembered per project**, so you don't have to re-enter them every time, and they won't be mixed up with other projects.

> **A little behind-the-scenes:** The video demo you see above was captured, edited, and exported using [GiffyPy](https://github.com/effessdev/GiffyPy), an all-in-one screen recording and video editing tool that I built myself, specifically for GitHub READMEs!

### Why you can trust it

**ReptClip only touches files that are tracked by git.** Anything your `.gitignore` files (at any depth) exclude is completely off-limits, for reading, searching, writing, creating, deleting, whatever. `.git` folders are always off-limits too.

Changing a `.gitignore` file always asks for confirmation first, since that can un-ignore something that was previously protected. If something ever goes wrong anyway, you can simply discard the changes with git.

And that's just the beginning. Continue reading to discover everything ReptClip has to offer!

## Features (detailed)

### Preparing Context

The generated context has the following sections (**each one can be toggled ON or OFF using checkboxes**):

- **Project structure:** lists the relative paths to all files in the project that have not been ignored using `.gitignore`, with their line count.
- **AI instructions:** contains the instructions regarding how to generate the output.
- **Files:** the files you attached (specified in "Files to attach" text box).
- **Prompt section:** an empty `# Prompt\n\n` section to type in your prompt.

After generating context via either the "Context" or "More Context" button, the status area shows a rough estimate of its token count (e.g. `~1.2k token(s)`), computed as characters divided by 4. This applies to both buttons: "Context" shows it alongside the file count, and "More Context" shows it alongside the file count and search results. It's a quick ballpark for how much of a chatbot's context window the output will use, not an exact count for any particular model's tokenizer.

You can attach files in the context by either entering the relative paths of them or a matching glob pattern in the **Files to attach** text box, separated by spaces. Mid-conversation context additions are handled by the **More Context** button (see [Adding more context](#adding-more-context-the-more-context-button)).

Example generated context when all sections are enabled and only `AGENTS.md` is attached:

````markdown
# Project structure

The number in parentheses after a file is its raw line count (including blank lines); binary or unreadable files are listed without one.

```
.gitignore (12)
AGENTS.md (9)
media/icon.png
src/main.py (387)
```

# AI instructions

[Placeholder: instructions on how to generate the output, omitted here due to length. See ./src/core/ai-instructions.md for the full text]

# Files

## AGENTS.md

```
Do not make mistakes.
```

# Prompt

<- Cursor lands here. You can quickly start typing.
````

To view the full contents of the "AI instructions" section, see [ai-instructions.md](./src/core/ai-instructions.md).

**Enter inside any input runs "Context"**, so you never have to reach for the button; while the suggestion dropdown is open, Enter/Tab _accepts_ the highlighted file instead, and `Shift + Enter` always inserts a newline.

You can uncheck "Copy to clipboard" to turn it off.

#### Live suggestions and syntax highlighting

A relative path or a glob pattern in "Files to attach" will turn **green** if they match at least one file, and turn **yellow** if they math no files. For "Files to exclude", green means it matches **at least one attached file**.

#### Order is preserved

The order in which you entered the relative paths or glob patterns is preserved. In case of redundant items, **the item that comes last gets order preference**, so if you set files to attach as `**/*.py main.py`, `main.py` comes after all other `.py` files. `**/*.py src/**/*.py` puts `.py` files in `src` last. This is particularly useful for putting the most important files closer to the prompt.

Example:

- **Files to attach:** `AGENTS.md **/*.py src/main.py`
- **Files to exclude:** `src/secret.py src/**/*.py`

This will attach `AGENTS.md` and all Python files, but exclude `src/secret.py` and all Python files in `tests`, and put `src/main.py` last:

#### Safety measures for context

- **Only files not excluded by `.gitignore` are ever considered**, using layered, per-directory `.gitignore` parsing (via the `ignore` package) rather than shelling out to git. This isn't just a filter on one feature's candidate list, it's enforced at the single chokepoint every embedded file read passes through, so no feature and no hand-written path list can bypass it.

- **`.gitignore` is a noise filter, not a secret filter.** A `.env` or key file that is not listed there is embedded verbatim and ends up in the chatbot and on the clipboard. Keep secrets ignored, or name them in **Files to exclude**.

- **Oversized and binary files are skipped automatically**, replaced by a descriptive placeholder in the output (limit: 1 MB; binaries detected via NUL-byte sniffing), they still appear in the project structure listing without a line count, since the same limit and binary check decide whether one can be shown.

- **There is no second implementation for "More Context" to worry about.** Its commands come from the clipboard instead of the pattern textareas, but `cat` paths are checked and read through the exact same pipeline as the Context button: same `.gitignore` enforcement, same size/binary guards, same Markdown builder. `grep` runs in-process via [grepts](https://github.com/ahmadawais/grepts) with `.gitignore` respect forced on (`--no-ignore` is refused), and every matched file is re-checked through the same embedding guard before any of its lines are embedded. The only difference is what gets wrapped around the results: More Context emits the requested file and search sections alone, no project structure, "AI instructions", or "Prompt" sections, so a mid-conversation supplement pastes cleanly on top of what the chatbot already has.

- **`.git` is always excluded, at any depth**, regardless of `.gitignore` content — not just a top-level `.git` folder, but a nested one too (e.g. inside a submodule).

### Write context to file

You can write the context to a file specifying the relative or absolute path to the file in the "Output file" text box. Leaving it empty will not write the output to any files.

### Applying diffs

When you click the "Apply diffs" button, the diffs are read from your clipboard and applied to the files.

Keep the AI instructions section turned ON so the AI has the rules needed to generate the diffs. It outputs all diffs in a single code block. Copy the block and click Apply diffs to apply.

Watch how beautifully ReptClip applies a large project reorganization:

<img width="1920" alt="ReptClip applying large diff" src="https://github.com/user-attachments/assets/a4c8c51e-2b10-4d00-9859-6e52c07c5336" />

Your chatbot can:

- Write, edit, and remove lines in a file
- Move or rename files
- Delete files

#### Safety measures for applying diffs

- **Applying a diff is all-or-nothing**: if any SEARCH block fails to validate (no match, not unique, edits a deleted file, etc.), the entire diff isn't applied, and you get an error message stating the reason.

- **SEARCH blocks support fuzzy matching**, trying an exact match first and only then falling back to tolerant matching: line-ending differences (CRLF/LF), trailing whitespace, shifted indentation, and tabs-vs-spaces. **A unique match is still required at every level**. The number of fuzzy SEARCH blocks (did not match the file byte-for-byte) will be displayed.

- **Dirty editor buffers win over the disk copy.** If a file is open with unsaved changes, matching and the checkpoint use the buffer, so a block that only exists in the editor is found and the unrelated unsaved lines are kept. Nothing is matched against a stale copy anymore.

- **A diff can only write files that aren't gitignored**, enforced by the exact same guard that governs reading — so whatever is off-limits for context is off-limits for diffs too, including through a symlink or junction. This has no override: if a path is ignored, writing it is refused outright.

- **`.git` is always refused**, at any depth, regardless of `.gitignore` content — git executes content from there (hooks, aliases, `core.fsmonitor`), so a diff must never be able to write to it.

- **A Windows NTFS alternate-data-stream alias can't bypass a `.gitignore` rule.** `.env::$DATA` refers to the same file as `.env`, so a diff targeting that alias is checked against `.gitignore` as if it were the plain path.

- **Editing, creating, deleting, or moving a `.gitignore` file asks for confirmation first.** Since changing one can un-ignore something previously protected (like `.env`), ReptClip won't apply such a change silently — you'll see a dialog explaining the risk before it goes through.

- **A diff path must stay inside the workspace, even through symlinks and junctions.** Diff paths are resolved with `fs.realpath` before anything is written, including dangling links, so a link inside the project cannot turn `linked/file.txt` into a write outside it. Hard links are not covered: they are the same file under a local path, so there is no path difference to detect.

- **Inserted lines follow the file's line endings.** A single-line SEARCH used to leave LF lines inside a CRLF file; the replacement is now converted to whichever convention the matched region (or the file) uses.

- **A `=======` line in the REPLACE half asks for confirmation.** It usually means the parser read the second separator as the boundary and the intended SEARCH tail was folded into the replacement, so the edit would change more than intended. Split the block instead, or confirm to apply anyway.

- **The last applied diff won't be silently re-applied**, clicking "Apply Diffs" hashes the parsed SEARCH/REPLACE blocks (so surrounding code fences, line-ending differences, and stray whitespace don't matter) and compares the hash against the last applied diff. That hash is stored persistently per project (only the most recent one is remembered), so the check still holds after restarting VS Code. When it matches, a confirmation dialog asks before re-applying, which you can accept to bypass the guard.

**Applied files are saved automatically**, and each file's regular undo (`Ctrl + Z`) still works.

### Undo and redo applied diffs

Next to the status message, **Undo** and **Redo** buttons step backward and forward through your last 10 applied diffs (each "Apply Diffs" click counts as one checkpoint). Undo restores every file touched by that diff to its exact pre-apply state, including recreating a file the diff deleted, or deleting one it created, and Redo reverses that. Both buttons are greyed out when there's nothing to step to. This history is kept in memory for the current VS Code session, separately from your regular per-file `Ctrl + Z` undo, and from the single remembered "already applied" fingerprint used to warn against re-applying the same diff.

Undo displays a warning if the file has been modified, checking both the saved file on disk and any unsaved changes in the editor.

### Adding more context: the "More Context" button

Paste-ready command blocks don't come only from you. The "AI instructions" section explicitly instructs the chatbot to emit one when it needs more context. Copy that block, click **More Context**, and the button does the rest: it reads the clipboard, runs the commands, and (depending on your settings) puts the result back on the clipboard and/or writes it to the "Output file".

Each non-empty line is one command, and the results appear in the order you pasted:

- **`cat <path>`** reads a file, e.g. `cat src/main.py` or `cat "docs/my file.md"`. Paths are quote-aware, but each `cat` takes exactly one path. `cat this fails` is an error, not two files.
- **`grep <flags> <pattern> [paths...]`** searches file contents using [grepts](https://github.com/ahmadawais/grepts), a TypeScript grep that runs in-process (no subprocess). Without paths it searches the whole project; with paths it searches only those files and directories.
- **`read-lines <path> <start_line> [end_line]`** reads a 1-indexed, inclusive range of lines from a file, e.g. `read-lines src/main.py 10 25`. `end_line` is optional. Omit it to read to the end of the file. If it's higher than the file's total line count, the range is simply clamped to the end of the file instead of erroring.

For example, this clipboard block:

```
cat "main.py"
grep -n "TODO" src
```

produces this output:

````
# Files

## main.py

```
Contents of main.py
```

## grep -n "TODO" src

```
src/app.py:12:# TODO: handle errors
src/util.py:3:# TODO rename
```
````

Here's what actually happens, in order:

1. **Parsing is line-by-line and forgiving where it should be, strict where it must be.** Each line is trimmed and split into quote-aware tokens, and empty lines (including runs of consecutive newlines) are skipped. The first token must be `cat`, `grep`, or `read-lines`. Anything else is an error.
2. **Pre-flight validation, all-or-nothing.** Before anything runs, every command is checked. `cat` and `read-lines` paths clear the embedding guard and are `fs.stat`-ed against the workspace root: not found, a directory rather than a file, ignored by `.gitignore`, inside `.git`, absolute, or resolving outside the project root all fail the check; `read-lines` additionally fails if `start_line` is past the file's actual line count. `grep` commands are parsed and validated up front too: invalid patterns, paths that fail the same checks, and unsupported flags all fail the check. Nothing is copied, nothing is written, no half-baked context reaches your clipboard; instead the panel names each offender and why. You fix the block and click again.
3. **Only then does it build.** `cat` and `read-lines` files are read through the shared pipeline (1 MB limit, binary detection, descriptive placeholders); `read-lines` then slices out the requested 1-indexed, inclusive line range (clamping `end_line` to the file's last line, or defaulting to it when omitted) before formatting. `grep` searches run in-process via grepts with `.gitignore` respect forced on, and matched files are re-checked through the embedding guard before their lines are embedded. The results are placed under `# Files`, with one `## <path>` (`cat`) or `## <the command as typed>` (`grep`, `read-lines`) subsection per command, and each subsection contains a code fence. The Project structure / AI instructions / Prompt section checkboxes are deliberately not applied, since those were already sent when you first generated the context.

| Supported `grep` flag(s) | Description                                      |
| :----------------------- | :----------------------------------------------- |
| `-i`                     | Ignore case                                      |
| `-n`                     | Show line numbers (on by default)                |
| `-N`, `--no-line-number` | Hide line numbers                                |
| `-c`                     | Show match count per file                        |
| `-l`                     | List only files with matches                     |
| `--files-without-match`  | List only files without matches                  |
| `-w`                     | Match whole words only                           |
| `-F`                     | Treat pattern as a literal string                |
| `-g <glob>`              | Filter files by glob pattern (e.g., `-g "*.ts"`) |
| `-m <n>`                 | Limit matches per file to `<n>`                  |
| `-v`, `--invert-match`   | Invert match (return non-matching lines)         |
| `-U`                     | Enable multiline matching                        |
| `--hidden`               | Include hidden files                             |
| `--max-depth <n>`        | Limit directory traversal depth to `<n>`         |
| `-e <pattern>`           | Specify search pattern                           |

- **Combined short flags & `--`:** Combined short flags (e.g., `-rn`) and `--` (end of flags) are supported.
- **No-op flags:** `-r`, `-R`, `-E`, and `--no-color` are accepted without effect.
- **Rejected flags:** Context flags (`-C`, `-A`, `-B`) are not supported by `grepts` yet; `--no-ignore` is rejected because ignored files are never searched; `-q` and `--quiet` are rejected because they would produce no output.

This also shows a rough token estimate.

## The UI

It contains the following sections:

- **Checkboxes (to control what goes in the context; all are ON by default):**
  - **Project structure:** The relative paths to the project files, along with a line count.
  - **AI instructions:** Turn this on so the chatbot will know that you are using ReptClip and respond accordingly.
  - **Files:** Includes attatched files (continue reading to learn how to attach files!)

- **Text boxes:**
  - **Files to attach:** Specify which files you want to include in the context. Enter relative file paths or glob patterns to match multiple files. Syntax highlighting and suggestions are supported!
  - **Files to exclude:** Specify which files to exclude from the attached files.
  - **Output file:** Empty by default. If you provide a relative or absolute path, the context will also be written to that file.

- **Buttons:**
  - **Context:** Clicking this button copies the context to your clipboard.
  - **More context:** We'll discuss this later 🙂‚
  - **Apply Diffs:** Reads the diffs from your clipboard and applies them.
  - **Button with a counterclockwise arrow icon:** Undoes the last diff (supports up to the last 10 diffs).
  - **Button with a clockwise arrow icon:** Redoes the last undone diff.

- **Other settings (checkboxes):**
  - **Copy to clipboard:** Whether to copy the context to the clipboard.
  - **Show labels:** Uncheck this to hide labels in the UI to save space.

The empty space between the **Apply Diffs** button and the undo button is used to display status messages and errors, including a rough estimate of the generated context's token count (e.g. `~1.2k token(s)`), shown after "Context" or "More Context" finishes.

It works wherever you place it. For example, in the bottom panel:

<img width="1356" alt="ReptClip in the panel" src="https://github.com/user-attachments/assets/ffdc154a-7d05-49d9-a65d-ac92b34d9bcd" />

In the sidebar:

<img width="1360" alt="ReptClip in the sidebar" src="https://github.com/user-attachments/assets/220ccc25-c858-420c-ab67-d5c4b6e7c352" />

Or even below the Explorer so your files, terminal, and ReptClip are visible at the same time! Like this:

<img width="1362" alt="ReptClip below the explorer" src="https://github.com/user-attachments/assets/e7a2e4ee-8573-461d-997f-e5ab64824e48" />

### UI Features

- **Side-by-side text areas:** The "Files to attach" and "Files to exclude" text areas are displayed side by side to make efficient use of screen space. When the available width is insufficient, they automatically switch to a vertical layout. You can drag the divider between them to adjust their relative widths. Both text areas automatically expand as you type and maintain the same height, eliminating the need for manual resizing.

- **Always-visible controls:** The "Context", "More Context", and "Apply Diffs" buttons, along with the status area and undo/redo buttons, remain visible at all times. When the available space is limited, the rest of the content becomes scrollable instead. This keeps the most important controls accessible without requiring you to scroll.

- **Overflow-free status area:** Status messages and errors wrap automatically instead of overflowing their container. If the content exceeds the available space, the status area becomes scrollable. This is rarely necessary, as there is usually enough room to display the messages.

- **Show labels checkbox:** You can uncheck "Show labels" in "Other settings" to hide labels to save space. Useful when you have memorized the UI layout and needs more vertical space.

- **Adaptive:** It works wherever you place it.

## Settings

Open VS Code's Settings (`Ctrl+,` / `Cmd+,`) and search for **"ReptClip"** to configure the default panel state used for any project that hasn't been opened in the panel yet (i.e. has no saved per-project state). Once a project has been used with the panel, its saved state takes over and these settings no longer apply to it.

| Setting                            | Default | Description                                                           |
| ---------------------------------- | ------- | --------------------------------------------------------------------- |
| `reptclip.defaultAttach`           | `""`    | Default value for the **Files to attach** field.                      |
| `reptclip.defaultExclude`          | `""`    | Default value for the **Files to exclude** field.                     |
| `reptclip.defaultClipboard`        | `true`  | Whether **Copy to clipboard** is checked by default.                  |
| `reptclip.defaultProjectStructure` | `true`  | Whether the **Project structure** section is checked by default.      |
| `reptclip.defaultDiffFormat`       | `true`  | Whether the **AI instructions** section is checked by default.        |
| `reptclip.defaultFiles`            | `true`  | Whether the **Files** section is checked by default.                  |
| `reptclip.defaultPromptTail`       | `true`  | Whether the **Prompt** section is checked by default.                 |
| `reptclip.defaultOutputFile`       | `""`    | Default value for the **Output file** field.                          |
| `reptclip.showLineCounts`          | `true`  | Show each file's raw line count in the **Project structure** section. |

## Frequently Asked Questions (FAQs)

**Q: Why can't I see the ReptClip tab in the bottom panel?**

**A:** If there's not enough space to display all panel tabs, ReptClip may be hidden under the `...` menu. To keep it easily accessible, simply drag its tab to the beginning of the list.
