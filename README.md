# ReptClip

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=effessdev.reptclip-for-vscode)
[![Open VSX](https://img.shields.io/badge/Open%20VSX-Registry-purple)](https://open-vsx.org/extension/effessdev/reptclip-for-vscode)

Paste your project as clean Markdown context into any free Chatbot, and apply the generated diffs in one click!

<img width="878" alt="ReptClip Panel UI" src="https://github.com/user-attachments/assets/917f77bd-0e2b-4191-8404-a1b72ae4fed2" />

**Note:** The animations below show an older version of ReptClip, while the screenshot above shows the latest UI.

## How it works

It's a 3-step process. Ideally, put VS Code and your free chatbot side-by-side.

### Step 1: Copy context to clipboard

Specify the files you want to include in the context. You can use relative paths or glob patterns. Press "Enter" or click the "Context" button to copy the context **straight to your clipboard**.

<img width="1152" alt="Copying context" src="https://github.com/user-attachments/assets/67367d63-fcb8-4951-9214-68fd5260eacf" />

Besides the files you specify, the context also includes the **project structure** and instructions on how to generate the output. You can enable/disable each section using checkboxes.

### Step 2: Paste context into your chatbot, along with your prompt

Send it and let it generate.

<img width="1920" alt="Pasting context and prompting" src="https://github.com/user-attachments/assets/b273215a-28f5-4ab8-8f00-3fc2a444a09f" />

### Step 3: Apply the generated diffs

The chatbot will provide the diffs in a single code block. Copy them, and click "Apply Diffs" to apply them.

<img width="1152" alt="Applying diffs" src="https://github.com/user-attachments/assets/881f3a25-8d73-4376-8890-c89fb0157614" />

### Optional step (before step 3): Add more context

If the chatbot wants to see more files or search the project, it will generate a code block containing custom `cat`, `grep`, and `read-lines` commands. You can copy that block and click the "More Context" button to copy output to the clipboard, and paste it back to the chatbot.

> **A little behind-the-scenes:** Every animated WebP you see above was captured, edited, and exported using [GiffyPy](https://github.com/effessdev/GiffyPy), an all-in-one screen recording and video editing tool that I built myself.

## How to use

1. Install the extension
2. Open the bottom panel using `` Ctrl + ` ``
3. Open the **ReptClip** tab in the panel (Click `...` if you can't see it)

**All settings are remembered per project**, so you don't have to re-enter them every time, and they won't be mixed up with other projects.

## Features

### Copying context to clipboard

The generated context has the following sections (**each one can be toggled ON or OFF using checkboxes**):

- **Project structure:** lists the relative paths to all files in the project that have not been ignored using `.gitignore`, with their line count.
- **AI instructions:** contains the instructions regarding how to generate the output.
- **Files:** the files you included in the context.
- **Prompt section:** an empty `# Prompt\n\n` section to type in your prompt.

The included files are placed between the "AI instructions" section and the "Prompt" section. You can include files to the context by either entering the relative paths of them or a matching glob pattern in the **Files to include** textarea, separated by spaces. Mid-conversation additions are handled by the **More Context** button (see [Adding more context](#adding-more-context)).

Example generated context (only `AGENTS.md` is included):

````markdown
# Project structure

The number in parentheses after a file is its raw line count (including blank lines); binary or unreadable files are listed without one.

```
.gitignore (12)
AGENTS.md (9)
README.md (210)
media/icon.png
src/main.py (387)
```

# AI instructions

The user is using the VS Code extension [ReptClip](https://github.com/effessdev/reptclip). You can utilize the following features of the extension.

## Reading files and searching

To read files or search the project, generate a code block containing one command per line:

- `cat <path>` reads a file. Quote paths that contain spaces, e.g. `cat "src/my file.ts"`. Each `cat` takes exactly one path.
- `grep <flags> <pattern> [paths...]` searches file contents, ripgrep-style. Without paths it searches the whole project.
- `read-lines <path> <start_line> [end_line]` reads a 1-indexed, inclusive range of lines from a file, e.g. `read-lines src/main.py 10 25`. Omit `end_line` to read to the end of the file; an `end_line` past the end of the file is simply clamped to it.

Useful flags: `-i` (ignore case), `-F` (literal string), `-w` (whole words), `-v` (invert match), `-l` (file names only), `-c` (match counts), `-m <n>` (max matches per file), `-g "*.ts"` (filter files by glob). Line numbers are included by default. Context flags (`-C` / `-A` / `-B`), `--no-ignore`, and `-q` are not supported, and searches always respect `.gitignore`.

Example:

```
cat README.md
cat "src/main.py"
grep -n "TODO" src
read-lines src/main.py 10 25
```

After generating the code block, ask the user to copy that code block and click the "More Context" button in the ReptClip panel to copy the file contents and search results to their clipboard, and paste it back to you.

Each command comes back under a top-level `# Files` section: `## <path>` contains a `cat` file's contents, `## <the grep command>` contains matching lines (`path:line:content`) for `grep`, and `## <the read-lines command>` contains the requested line range for `read-lines`.

Before generating any edits (below), make sure you have the current contents of every file you plan to edit. If you don't have a file's contents, or can't confirm they're current, request it via these commands first rather than guessing at the content.

## Editing files

To edit the files, generate all file modifications as Search/Replace blocks inside a single 4-backtick code block (see example below). Then, tell the user to copy that code block and click "Apply Diffs" in the ReptClip panel to apply these changes.

### Example code block

```
src/models/user.py
<<<<<<< SEARCH
class User:
    def __init__(self, name):
        self.name = name

    def to_dict(self):
        return {"name": self.name}
=======
class User:
    def __init__(self, name, email):
        self.name = name
        self.email = email

    def to_dict(self):
        return {
            "name": self.name,
            "email": self.email,
        }
>>>>>>> REPLACE

src/controllers/user_controller.py
<<<<<<< SEARCH
from src/models.user import User
=======
from src/models.user import User
from src.utils.validator import validate_email
>>>>>>> REPLACE
<<<<<<< SEARCH
def create_user(name):
    return User(name)
=======
def create_user(name, email):
    validate_email(email)
    return User(name, email)
>>>>>>> REPLACE
<<<<<<< SEARCH
def legacy_create_user(name):
    return User(name)

>>>>>>> REPLACE

src/utils/validator.py
<<<<<<< SEARCH
=======
def validate_email(email):
    if "@" not in email:
        raise ValueError("Invalid email address")
>>>>>>> REPLACE

config/legacy.json
<<<<<<< SEARCH
{
    "deprecated": true
}
=======
>>>>>>> REPLACE
```

#### Explanation

1. **File Headers:** Every set of edits must begin with the exact relative file path on its own line (e.g., `path/to/file.ext`), even if there is only a single file in the project. When a block contains edits for more than one file, separate each file's section with a blank line.

2. **Exact Matching:** The `SEARCH` block must contain an _exact, verbatim_ copy of existing code, including identical whitespace, indentation, and surrounding context lines to uniquely identify the match. The tool falls back to whitespace-tolerant matching if the exact text isn't found, but this is a safety net, not something to rely on — always aim for an exact match, since a bad fallback match can still fail or match the wrong place.

3. **Uniqueness:** Provide sufficient surrounding unchanged lines in the `SEARCH` block to ensure it matches exactly **one** location in the target file.

4. **New Files, Moves & Deletions:**
   - To create a new file, use an empty `SEARCH` block.
   - An empty `REPLACE` block removes the matched text but keeps the file, including if the file becomes empty.
   - To move or rename a file without modifying it, use `old/path.txt -> new/path.txt` on its own line.
   - To delete a whole file, use `old/path.txt delete` on its own line.

5. **No Placeholders:** Do not use ellipses (`...`), comments like `# rest of code unchanged`, or omitted lines inside `SEARCH` or `REPLACE` blocks.

6. **Sequential Edits:** For multiple blocks on the same file, write each `SEARCH` to match the file as it will exist at the moment that block is applied. I.e., after all earlier blocks in your list have already been applied to that file. List them in the order you intend them to be applied sequentially.

7. **No Marker Collisions:** Inside `SEARCH`, a trimmed line equal to `=======` ends the block early — it's read as the separator. Inside `REPLACE`, a trimmed line starting with `>>>>>>> REPLACE` ends the block early, and a line equal to `=======` triggers a suspicious-edit warning that can block the apply. A `<<<<<<< SEARCH` line is harmless in either block. If matched code requires one of these, split the edit so the line falls outside the block; if that's not possible, tell the user instead of continuing.

# Files

## AGENTS.md

```
Do not make mistakes.
```

# Prompt

<- Cursor lands here. You can quickly start typing.
````

**Enter inside any input runs "Context"**, so you never have to reach for the button; while the suggestion dropdown is open, Enter/Tab _accepts_ the highlighted file instead, and `Shift + Enter` always inserts a newline.

You can uncheck "Copy to clipboard" to turn it off.

#### Safety measures for context

- **Only files not excluded by `.gitignore` are ever considered**, using layered, per-directory `.gitignore` parsing (via the `ignore` package) rather than shelling out to git. This isn't just a filter on one feature's candidate list, it's enforced at the single chokepoint every embedded file read passes through, so no feature and no hand-written path list can bypass it.

- **`.gitignore` is a noise filter, not a secret filter.** A `.env` or key file that is not listed there is embedded verbatim and ends up in the chatbot and on the clipboard. Keep secrets ignored, or name them in **Files to exclude**.

- **Oversized and binary files are skipped automatically**, replaced by a descriptive placeholder in the output (limit: 1 MB; binaries detected via NUL-byte sniffing), they still appear in the project structure listing — without a line count, since the same limit and binary check decide whether one can be shown.

- **There is no second implementation for "More Context" to worry about.** Its commands come from the clipboard instead of the pattern textareas, but `cat` paths are checked and read through the exact same pipeline as the Context button: same `.gitignore` enforcement, same size/binary guards, same Markdown builder. `grep` runs in-process via [grepts](https://github.com/ahmadawais/grepts) with `.gitignore` respect forced on (`--no-ignore` is refused), and every matched file is re-checked through the same embedding guard before any of its lines are embedded. The only difference is what gets wrapped around the results: More Context emits the requested file and search sections alone, no project structure, "AI instructions", or "Prompt" sections, so a mid-conversation supplement pastes cleanly on top of what the chatbot already has.

### Write context to file

You can write the context to a file specifying the relative or absolute path to the file in the "Output file" text box. Leaving it empty will not write the output to any files.

### Applying diffs

When you click the "Apply diffs" button, the diffs are read from your clipboard and applied to the files.

If you have turned on the "AI instructions" section, the AI will generate the diffs in a single code block. You can copy those diffs, and click "Apply diffs" to apply them.

#### Safety measures for applying diffs

- **Applying a diff is all-or-nothing**: if any SEARCH block fails to validate (no match, not unique, edits a deleted file, etc.), the entire diff isn't applied, and you get an error message stating the reason.

- **SEARCH blocks support fuzzy matching**, trying an exact match first and only then falling back to tolerant matching: line-ending differences (CRLF/LF), trailing whitespace, shifted indentation, and tabs-vs-spaces. **A unique match is still required at every level**. The number of fuzzy SEARCH blocks (did not match the file byte-for-byte) will be displayed.

- **Dirty editor buffers win over the disk copy.** If a file is open with unsaved changes, matching and the checkpoint use the buffer, so a block that only exists in the editor is found and the unrelated unsaved lines are kept. Nothing is matched against a stale copy anymore.

- **Protected paths are refused by default.** A diff cannot write anything inside `.git` (git executes content from there: hooks, aliases, `core.fsmonitor`) or to `.env` / `.env.*` (swapping the environment file is a configuration change), including when the path reaches them through a link or an NTFS stream alias. Set `reptclip.allowProtectedFileWrites` to `true` to get a confirmation dialog per apply instead of a hard refusal.

- **A diff path must stay inside the workspace, even through symlinks and junctions.** Diff paths are resolved with `fs.realpath` before anything is written, including dangling links, so a link inside the project cannot turn `linked/file.txt` into a write outside it. Hard links are not covered: they are the same file under a local path, so there is no path difference to detect.

- **Inserted lines follow the file's line endings.** A single-line SEARCH used to leave LF lines inside a CRLF file; the replacement is now converted to whichever convention the matched region (or the file) uses.

- **A `=======` line in the REPLACE half asks for confirmation.** It usually means the parser read the second separator as the boundary and the intended SEARCH tail was folded into the replacement, so the edit would change more than intended. Split the block instead, or confirm to apply anyway.

- **The last applied diff won't be silently re-applied**, clicking "Apply Diffs" hashes the parsed SEARCH/REPLACE blocks (so surrounding code fences, line-ending differences, and stray whitespace don't matter) and compares the hash against the last applied diff. That hash is stored persistently per project (only the most recent one is remembered), so the check still holds after restarting VS Code. When it matches, a confirmation dialog asks before re-applying, which you can accept to bypass the guard.

**Applied files are saved automatically**, and each file's regular undo (`Ctrl + Z`) still works.

### Undo and redo applied diffs

Next to the status message, **Undo** and **Redo** buttons step backward and forward through your last 10 applied diffs (each "Apply Diffs" click counts as one checkpoint). Undo restores every file touched by that diff to its exact pre-apply state — including recreating a file the diff deleted, or deleting one it created — and Redo reverses that. Both buttons are greyed out when there's nothing to step to. This history is kept in memory for the current VS Code session, separately from your regular per-file `Ctrl + Z` undo, and from the single remembered "already applied" fingerprint used to warn against re-applying the same diff.

Undo displays a warning if the file has been modified, checking both the saved file on disk and any unsaved changes in the editor.

### Adding more context

#### Up front: the pattern textareas

Pick the files before generating, with two textareas:

- **Files to include:** Specify which files to include in the context, separated by spaces. You can use the relative paths, or glob patterns to match files.
- **Files to exclude:** Specify which files you want to exclude from the included files. Particuluarly useful when you want to include a lot of files using a glob pattern, but exclude a specific file from them.

You will get **suggestions** and **syntax highlighting** as you type the files. A relative path or a glob pattern in "Files to include" will turn **green** if they match at least one file, and turn **yellow** if they math no files. For "Files to exclude", green means it matches **at least one included file**.

The order in which you entered the relative paths or glob patterns is preserved. In case of redundant items, **the item that comes last gets order preference**, so if you set files to include as `**/*.py main.py`, `main.py` comes after all other `.py` files. `**/*.py src/**/*.py` puts `.py` files in `src` last.

##### Example

Include `AGENTS.md`, all Python files, but exclude `src/secret.py` and all Python files in `tests`, and put `src/main.py` last:

- **Files to include:** `AGENTS.md **/*.py src/main.py`
- **Files to exclude:** `src/secret.py src/**/*.py`

#### Mid-conversation: the "More Context" button

Paste-ready command blocks don't come only from you. The "AI instructions" section explicitly instructs the chatbot to emit one when it needs more context. Copy that block, click **More Context**, and the button does the rest: it reads the clipboard, runs the commands, and (depending on your settings) puts the result back on the clipboard and/or writes it to the "Output file".

Each non-empty line is one command, and the results appear in the order you pasted:

- **`cat <path>`** reads a file, e.g. `cat src/main.py` or `cat "docs/my file.md"`. Paths are quote-aware, but each `cat` takes exactly one path — `cat this fails` is an error, not two files.
- **`grep <flags> <pattern> [paths...]`** searches file contents using [grepts](https://github.com/ahmadawais/grepts), a TypeScript grep that runs in-process (no subprocess). Without paths it searches the whole project; with paths it searches only those files and directories.
- **`read-lines <path> <start_line> [end_line]`** reads a 1-indexed, inclusive range of lines from a file, e.g. `read-lines src/main.py 10 25`. `end_line` is optional — omit it to read to the end of the file — and if it's higher than the file's total line count, the range is simply clamped to the end of the file instead of erroring.

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

1. **Parsing is line-by-line and forgiving where it should be, strict where it must be.** Each line is trimmed and split into quote-aware tokens, and empty lines (including runs of consecutive newlines) are skipped. The first token must be `cat`, `grep`, or `read-lines` — anything else is an error.
2. **Pre-flight validation, all-or-nothing.** Before anything runs, every command is checked. `cat` and `read-lines` paths clear the embedding guard and are `fs.stat`-ed against the workspace root: not found, a directory rather than a file, ignored by `.gitignore`, inside `.git`, absolute, or resolving outside the project root all fail the check; `read-lines` additionally fails if `start_line` is past the file's actual line count. `grep` commands are parsed and validated up front too: invalid patterns, paths that fail the same checks, and unsupported flags all fail the check. Nothing is copied, nothing is written, no half-baked context reaches your clipboard; instead the panel names each offender and why. You fix the block and click again.
3. **Only then does it build.** `cat` and `read-lines` files are read through the shared pipeline (1 MB limit, binary detection, descriptive placeholders); `read-lines` then slices out the requested 1-indexed, inclusive line range (clamping `end_line` to the file's last line, or defaulting to it when omitted) before formatting. `grep` searches run in-process via grepts with `.gitignore` respect forced on, and matched files are re-checked through the embedding guard before their lines are embedded. The results are placed under `# Files`, with one `## <path>` (`cat`) or `## <the command as typed>` (`grep`, `read-lines`) subsection per command, and each subsection contains a code fence. The Project structure / AI instructions / Prompt section checkboxes are deliberately not applied, since those were already sent when you first generated the context.

Supported `grep` flags: `-i` (ignore case), `-n` (line numbers, on by default), `-N` / `--no-line-number`, `-c` (count per file), `-l` (files with matches), `--files-without-match`, `-w` (whole words), `-F` (literal string), `-g <glob>` (filter files, e.g. `-g "*.ts"`), `-m <n>` (max matches per file), `-v` / `--invert-match`, `-U` (multiline), `--hidden`, `--max-depth <n>`, and `-e <pattern>`. Combined short flags (`-rn`) and `--` work too, and `-r` / `-R` / `-E` / `--no-color` are accepted as no-ops. Context flags (`-C` / `-A` / `-B`) are not supported by grepts yet and are rejected, as are `--no-ignore` (ignored files are never searched) and `-q` / `--quiet` (they would produce no output).

## Settings

Open VS Code's Settings (`Ctrl+,` / `Cmd+,`) and search for **"ReptClip"** to configure the default panel state used for any project that hasn't been opened in the panel yet (i.e. has no saved per-project state). Once a project has been used with the panel, its saved state takes over and these settings no longer apply to it.

| Setting                             | Default | Description                                                              |
| ----------------------------------- | ------- | ------------------------------------------------------------------------ |
| `reptclip.defaultInclude`           | `""`    | Default value for the **Files to include** field.                        |
| `reptclip.defaultExclude`           | `""`    | Default value for the **Files to exclude** field.                        |
| `reptclip.defaultClipboard`         | `true`  | Whether **Copy to clipboard** is checked by default.                     |
| `reptclip.defaultProjectStructure`  | `true`  | Whether the **Project structure** section is checked by default.         |
| `reptclip.defaultDiffFormat`        | `true`  | Whether the **AI instructions** section is checked by default.           |
| `reptclip.defaultFiles`             | `true`  | Whether the **Files** section is checked by default.                     |
| `reptclip.defaultPromptTail`        | `true`  | Whether the **Prompt** section is checked by default.                    |
| `reptclip.defaultOutputFile`        | `""`    | Default value for the **Output file** field.                             |
| `reptclip.allowProtectedFileWrites` | `false` | Allow diffs that write `.git/**` or `.env*` after a confirmation dialog. |
| `reptclip.showLineCounts`           | `true`  | Show each file's raw line count in the **Project structure** section.    |
