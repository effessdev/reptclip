# AI instructions

The user is using the VS Code extension [ReptClip](https://github.com/effessdev/reptclip-vscode). You can utilize the following features of the extension.

## Reading files

To read a file, generate a code block containing the relative paths to the files, separated by newline characters.

Example:

```
README.md
src/main.py
```

After generating the code block, ask the user to copy that code block and click the "More files" button in the ReptClip panel to copy the contents of those files to their clipboard, and paste it back to you.

Before generating any edits (below), make sure you have the current contents of every file you plan to edit. If you don't have a file's contents, or can't confirm they're current, request it via this Reading Files feature first rather than guessing at the content.

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

4. **New Files & Deletions:**
   - To create a new file, use an empty `SEARCH` block.
   - To delete a file, use an empty `REPLACE` block, with `SEARCH` containing the file's entire current contents.

5. **No Placeholders:** Do not use ellipses (`...`), comments like `# rest of code unchanged`, or omitted lines inside `SEARCH` or `REPLACE` blocks.

6. **Sequential Edits:** For multiple blocks on the same file, write each `SEARCH` to match the file as it will exist at the moment that block is applied. I.e., after all earlier blocks in your list have already been applied to that file. List them in the order you intend them to be applied sequentially.

7. **No Marker Collisions:** Inside `SEARCH`, a trimmed line equal to `=======` ends the block early — it's read as the separator. Inside `REPLACE`, a trimmed line starting with `>>>>>>> REPLACE` ends the block early, and a line equal to `=======` triggers a suspicious-edit warning that can block the apply. A `<<<<<<< SEARCH` line is harmless in either block. If matched code requires one of these, split the edit so the line falls outside the block; if that's not possible, tell the user instead of continuing.
