# ReptClip - Fast Context for Your ChatBot

A fast, cross-platform CLI that turns a project directory into clean Markdown context for an LLM chat (no `.gitignore`ed files), and copies it straight to your clipboard.

<img src="assets/preview.webp" alt="Preview" width="100%">

> ## Note: ReptClip is Now Available in VS Code & VS Code Compatible Editors!
>
> I have created a VS Code extension inspired by the same app, which is much easier & faster to use than this one. You'll get:
> 
> - Suggestions as you type
> - Syntax highlighting
> - Quotes being optional for glob patterns
> - Intuitive UI (a tutorial isn't required)
> 
> It supports standard VS Code via the Visual Studio Marketplace, as well as VSCodium, Cursor, Windsurf, Eclipse Theia, and other compatible editors via the Open VSX Registry.
> 
> GitHub Repository: [ReptClip for VS Code](https://github.com/effessdev/reptclip-vscode)

## Install

### Windows

After installing Python, run:

```bash
pip install reptclip
```

### Ubuntu

```bash
sudo apt update && sudo apt install pipx
pipx install reptclip
pipx ensurepath
```

## Basic Usage

Run the `reptclip` command or its left-hand alias `rrcc` from the root of your project:

```bash
rrcc
```

This copies a Markdown snapshot of your project structure (every non-ignored file) to the clipboard, ready to paste into an LLM chat.

Example output:

````markdown
# Project structure

```
.gitignore
README.md
docs/README.md
src/functions.py
src/main.py
```

# Prompt

<- Cursor stays here, you can quickly start typing
````

## Natural CLI Syntax

ReptClip supports simple, readable English commands.

### Including & Excluding Files

Glob patterns are used to specify which files to include in the context. For example:

```bash
rrcc "AGENTS.md"
```

Example output for this command:

````markdown
# Project structure

```
.gitignore
README.md
docs/README.md
src/functions.py
src/main.py
```

# AGENTS.md

```
Contents of AGENTS.md.
```

# Prompt
````

To specify files to exclude, use `e` or `exclude`. Here is an example:

```bash
rrcc "**/*.py" "AGENTS.md" e "src/secret.py"
```

This includes all `.py` files and `AGENTS.md`, while excluding `secret.py`.

### Output, Clipboard & Prompt Tail Controls

You can control output targets and prompt behavior directly from the command line:

- **Output File**: `o "output.md"` or `output "output.md"` writes the snapshot to a file (use `""` to disable).
- **Clipboard Toggle**: `c` / `clipboard` enables copying; `nc` / `no-clipboard` disables it.
- **Prompt Tail Toggle**: `pt` / `prompt-tail` appends `# Prompt\n\n` at the end; `npt` / `no-prompt-tail` disables it.

Example combining options:

```bash
rrcc "**/*.py" npt o "out.md" nc
```

## Config File, Default Settings, and Presets

You can define presets in `reptclip-config.toml`. Create a default one by running:

```bash
rrcc init
```

Default configuration:

```toml
[[presets]]
name = "default"
include = ["AGENTS.md"]
exclude = []
output = ""
clipboard = true
prompt_tail = true

[[presets]]
name = "all"
include = ["**"]
exclude = []
```

The preset named `default` is always applied. This can be used for **defining default configurations**. Other presets can be applied using `p` or `preset`:

```bash
rrcc p mypreset
```

### Command Reference

| Action              | Short | Long             | Alternate / Flag forms |
| :------------------ | :---- | :--------------- | :--------------------- |
| **Include**         | `i`   | `include`        | `-i`, `--include`      |
| **Exclude**         | `e`   | `exclude`        | `-e`, `--exclude`      |
| **Preset**          | `p`   | `preset`         | `-p`, `--preset`       |
| **Output File**     | `o`   | `output`         | `-o`, `--output`       |
| **Clipboard On**    | `c`   | `clipboard`      | `-c`, `--clipboard`    |
| **Clipboard Off**   | `nc`  | `no-clipboard`   | `--no-clipboard`       |
| **Prompt Tail On**  | `pt`  | `prompt-tail`    | `--prompt-tail`        |
| **Prompt Tail Off** | `npt` | `no-prompt-tail` | `--no-prompt-tail`     |

## Notes

- **GitIgnore Aware**: Files ignored by `.gitignore` rules are automatically excluded via pure Python tree traversal.
- **Automatic Guards**: Binary files and files over 1 MB are automatically skipped with descriptive placeholders instead of causing errors.
- **Rule Precedence**: CLI options extend and override configured preset rules sequentially.
