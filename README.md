# ReptClip - Fast Context for Your ChatBot

A fast, cross-platform CLI that turns a project directory into clean Markdown context for an LLM chat — and copies it straight to your clipboard.

<p align="center">
  <img src="assets/preview.gif" alt="Preview" width="2000">
</p>

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

ReptClip supports simple, readable English commands. Keywords do not require hyphens, and arguments are included by default.

### Including & Excluding Files

Glob patterns passed as positional arguments are automatically included. To specify excludes, use `e` or `exclude`:

```bash
rrcc "**/*.py" "AGENTS.md" e "src/secret.py"
```

If preferred, you can also use `i` or `include` explicitly:

```bash
rrcc i "file1.py" "file2.py" e "src/secret.py"
```

_Note: Traditional hyphenated flags (`-i`, `--include`, `-e`, `--exclude`) are fully supported for backwards compatibility._

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
output_file = ""  # Relative path to write output (leave empty to skip)
copy_to_clipboard = true
prompt_tail = true

[[presets]]
name = "all"
include = ["**"]
exclude = []
```

The preset named `default` is always applied. This can be used for **defining default configurations**. Other presets can be applied like this:

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

- **GitIgnore Integration**: Files ignored by `.gitignore` rules are automatically excluded via pure Python tree traversal.
- **Automatic Guards**: Binary files and files over 1 MB are automatically skipped with descriptive placeholders instead of causing errors.
- **Rule Precedence**: CLI options extend and override configured preset rules sequentially.
