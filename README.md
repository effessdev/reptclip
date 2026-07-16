# ReptClip

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

## Advanced Usage

### Including file contents

To also include the contents of specific files, pass include/exclude glob
patterns (`*` and `**` are supported):

```bash
rrcc -i src/**/*.py docs/ -e src/confidential.py
```

This includes every `.py` file in `src/` and everything under `docs/`, while excluding one specific `.py` file in `src`.
Use quotes around any pattern that contains spaces.

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

## Notes

- Only files tracked by git are ever considered.
- No files' contents are included unless you explicitly ask for them via
  `-i` or the config file — the project structure is always shown, though.
- Binary files and files over 1 MB are automatically skipped (with a note
  in the output) instead of causing an error.

## Contributing

Thanks for considering contributing to this project!

Please refer to the [Developer Documentation](/docs/dev/README.md) for setup instructions, coding standards, and our workflow.
