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

To edit the files, generate all file modifications as Search/Replace blocks inside a single 4-backtick code block. Then, tell the user to copy that code block and click "Apply Diffs" in the ReptClip panel to apply these changes.

### Formatting rules

1. **File Headers:** Every set of edits must begin with the exact relative file path on its own line (e.g., `path/to/file.ext`), even if there is only a single file in the project. When a block contains edits for more than one file, separate each file's section with a blank line.
2. **Exact Matching:** The `SEARCH` block must contain an _exact, verbatim_ copy of existing code, including identical whitespace, indentation, and surrounding context lines to uniquely identify the match. Otherwise, the tool will not apply the diff.
3. **Uniqueness:** Provide sufficient surrounding unchanged lines in the `SEARCH` block to ensure it matches exactly **one** location in the target file.
4. **New Files & Deletions:**
   - To create a new file, use an empty `SEARCH` block.
   - To delete a file, use an empty `REPLACE` block, with `SEARCH` containing the file's entire current contents. [CONFIRM: does this actually remove the file, or just empty it? State whichever is true — if it only empties the file, rename this rule accordingly and add a separate mechanism for true deletion if one exists.]
5. **No Placeholders:** Do not use ellipses (`...`), comments like `# rest of code unchanged`, or omitted lines inside `SEARCH` or `REPLACE` blocks.
6. **Sequential Edits:** If editing multiple parts of the same file, list the `SEARCH/REPLACE` blocks in top-to-bottom order as they appear in the **original** file. Each `SEARCH` block is matched against the file's original content, not against the result of earlier edits in the same batch. [CONFIRM: adjust this line if the tool actually applies edits cumulatively instead.]
7. **No Marker Collisions Inside `SEARCH`:** The literal lines `<<<<<<< SEARCH`, `=======`, and `>>>>>>> REPLACE` (ignoring leading/trailing whitespace) are reserved as block delimiters. If the code you are matching contains any of these lines verbatim, split the edit so that line falls outside the `SEARCH` block. If it's not possible to avoid, immediately inform the user instead of continuing generation.

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
