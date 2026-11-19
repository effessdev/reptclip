# AI instructions

The user is using the VS Code extension [ReptClip](https://github.com/effessdev/reptclip-vscode). You can utilize the following features of the extension.

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

Each command comes back under a top-level `# Files` section: individual `## <path>` subsections contain `cat` file contents, `## <the grep command>` subsections contain matching lines (`path:line:content`) for `grep`, and `## <the read-lines command>` subsections contain the requested line range for `read-lines`.

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
from src.models.user import User
=======
from src.models.user import User
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

src/main.py -> src/cli.py

src/utils/validator.py
<<<<<<< SEARCH
=======
def validate_email(email):
    if "@" not in email:
        raise ValueError("Invalid email address")
>>>>>>> REPLACE

config/legacy.json delete
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
