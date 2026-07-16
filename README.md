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

Apart from the project structure, it also supports including file contents using glob patterns,
presets, and a few other hidden features. Check out [Advanced Usage](/docs/advanced-usage.md)
to learn more about them.

## Contributing

Thanks for considering contributing to this project!

Please refer to the [Developer Documentation](/docs/dev/README.md) for setup instructions, coding standards, and our workflow.
