# ReptClip - Fast Context for Your ChatBot

A fast, cross-platform CLI that turns a git repository into clean Markdown
context for an LLM chat — and copies it straight to your clipboard.

<p align="center">
  <img src="assets/preview.gif" alt="Preview" width="2000">
</p>

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

You can use the `-i` or `--include` flag to specify files to include and the
`-e` or `--exclude` flag to exclude files from the final selection. You can use
relative paths or glob patterns to specify the files:

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

<- Cursor stays here, so you can start typing quickly
````

If you want to include the contents all files, use

```bash
rrcc -i "**"
```

Binary files and files over 1 MB are automatically skipped
(with a note in the output) instead of causing an error. Binary files are
identified using extensions as well as file contents.

### Config file

You can store default include/exclude rules in a `reptclip-config.toml` in your
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

Pattern precedence is applied in this order:

1. config includes
2. config excludes
3. preset includes
4. preset excludes
5. CLI includes
6. CLI excludes

In practice, config values act as the base layer, preset values extend them, and
CLI flags take highest precedence for the final selection. You can apply a preset
with `-p` or `--preset`:

```bash
rrcc -p all
```

### Notes

- Only files tracked by git are ever considered.
- No files' contents are included unless you explicitly ask for them via
  `-i` or the config file — the project structure is always shown, though.
- Binary files and files over 1 MB are automatically skipped (with a note
  in the output) instead of causing an error.
