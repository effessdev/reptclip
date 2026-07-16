# ReptClip - Fast Context for Your ChatBot

A fast, cross-platform CLI that turns a git repository into clean Markdown
context for an LLM chat — and copies it straight to your clipboard.

## Install

### Windows

After installing python, run

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

Run the `reptclip` command from the root of a git repository:

```bash
reptclip
```

Or you can also use its shorter alias `rrcc` (recommended), which can be typed using your left hand only:

```bash
rrcc
```

This copies a Markdown snapshot of your project structure (every
git-tracked file, as a tree listing) to the clipboard, ready to paste into
a chat.

Example output:

````
# Project structure

```
.gitignore
README.md
docs/README.md
src/functions.py
src/main.py
```

# Prompt


````

It also includes a prompt section at the end, so you can start typing your prompt
right away after pasting into the chat box.

## Advanced Usage

### Including file contents

You can use the `-i` or `--include` flag to specify the files to include and
`-e` or `--exclude` flag to specify certain files that you included. You can
use relative paths or glob patterns to specify the files:

```bash
rrcc -i AGENTS.md src/**/*.py docs/ -e src/functions.py
```

This includes `AGENTS.md`, every `.py` file in `src/` and everything under `docs/`,
while excluding one specific `.py` file in `src` (`functions.py`).
Use quotes around any pattern that contains spaces.

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

# AGENTS.md

```
Contents of AGENTS.md
```

# docs/README.md

```
Contents of docs/README.md
```

# src/main.py

```
Contents of src/main.py
```

# Prompt
````

Binary files and files over 1 MB are automatically skipped
(with a note in the output) instead of causing an error. Binary files are
identified using extensions as well as file contents.

### Config file

Instead of (or in addition to) CLI flags, drop a `reptclip-config.toml` in your
project root. You can create a starter file with:

```bash
reptclip config
```

Example contents:

```toml
include = ["AGENTS.md", "src/**/*.py", "docs/"]
exclude = ["src/generated/**"]

[[presets]]
name = "all"
include = ["**"]
exclude = []
```

Patterns from the CLI and the config file are combined. If you define one or
more presets in the config file, you can also apply them with `-p` or
`--preset`:

```bash
rrcc -p all
```

The selected presets' include and exclude patterns are merged with the CLI and
config file patterns before filtering.

### Notes

- Only files tracked by git are ever considered.
- No files' contents are included unless you explicitly ask for them via
  `-i` or the config file — the project structure is always shown, though.
- Binary files and files over 1 MB are automatically skipped (with a note
  in the output) instead of causing an error.

## Contributing

Thanks for considering contributing to this project!

Please refer to the [Developer Documentation](/docs/dev/README.md) for setup instructions, coding standards, and our workflow.
