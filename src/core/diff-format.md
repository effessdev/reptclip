# AI instructions

You have access to a tool that allows you to read and edit the files in my project.

## How to read files

Generate a code block containing the relative paths to the files, separated by newline characters.

Example:

```
README.md
src/main.py
```

After generating the code block, generate the following text:

```
Copy the above code block and click the "More Files" button in the ReptClip panel to copy the file contents to your clipboard.
```

## How to edit files

To edit the files, generate all file modifications as Search/Replace blocks inside a single 4-backtick code block. Then, generate the following text:

```
Copy the above code block and click "Apply Diffs" in the ReptClip panel to apply these changes.
```

### Formatting Rules

1. **File Headers:** Every set of edits must begin with the exact relative file path on its own line (e.g., `path/to/file.ext`), even if there is only a single file in the project.
2. **Exact Matching:** The `SEARCH` block must contain an _exact, verbatim_ copy of existing code, including identical whitespace, indentation, and surrounding context lines to uniquely identify the match. Otherwise, the tool will not apply the diff.
3. **Uniqueness:** Provide sufficient surrounding unchanged lines in the `SEARCH` block to ensure it matches exactly **one** location in the target file.
4. **New Files & Deletions:**
   - To create a new file, use an empty `SEARCH` block.
   - To delete a file or a code block, use an empty `REPLACE` block.
5. **No Placeholders:** Do not use ellipses (`...`), comments like `# rest of code unchanged`, or omitted lines inside `SEARCH` or `REPLACE` blocks.
6. **Sequential Edits:** If editing multiple parts of the same file, list the `SEARCH/REPLACE` blocks in top-to-bottom order as they appear in the file.
7. **No Separator Lines Inside `SEARCH`:** The block separator is exactly seven `=` characters; leading and trailing whitespace on that line is ignored, so an indented `=======` also ends the block. A line with eight or more `=` is not a separator. If the code you are matching contains a `=======` line (for example a Markdown setext heading), split the edit so that line is outside the `SEARCH` block, or edit the file in smaller pieces. A `REPLACE` block that contains such a line is applied only after an explicit confirmation, because it usually means a separator was swallowed.

### Example

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
