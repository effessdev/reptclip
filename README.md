# ReptClip (`ccc`)

A fast, cross-platform CLI that turns a git repository into clean Markdown
context for an LLM chat — and copies it straight to your clipboard.

## Install

```bash
pip install reptclip
```

## Usage

Run `ccc` from the root of a git repository:

```bash
ccc
```

This copies a Markdown snapshot of your project structure (every
git-tracked file, as a tree listing) to the clipboard, ready to paste into
a chat.

To also include the contents of specific files, pass include/exclude glob
patterns (`*` and `**` are supported):

```bash
ccc -i src/**/*.cpp tests/**/*.cpp docs/ -e tests/VeryLargeTest.cpp
```

This includes every `.cpp` file under `src/`, every `.cpp` file under
`tests/`, and everything under `docs/`, while excluding one large test file.
Use quotes around any pattern that contains spaces.

## Config file

Instead of (or in addition to) CLI flags, drop a `ccc-config.toml` in your
project root:

```toml
include = ["src/**/*.py", "docs/"]
exclude = ["src/generated/**"]
```

Patterns from the CLI and the config file are combined.

## Notes

- Only files tracked by git are ever considered.
- No files' contents are included unless you explicitly ask for them via
  `-i` or the config file — the project structure is always shown, though.
- Binary files and files over 1 MB are automatically skipped (with a note
  in the output) instead of causing an error.

## Development

```bash
pip install -e ".[dev]"
pytest
```
