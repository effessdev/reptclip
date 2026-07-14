"""Building the final markdown output that gets copied to the clipboard."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

ReadFileFunc = Callable[[Path], str]


def build_project_structure(tracked_files: list[str]) -> str:
    """Build the '# Project structure' section listing every tracked file."""
    file_list = "\n".join(tracked_files)
    return f"# Project structure\n\n```\n{file_list}\n```\n"


def build_file_section(rel_path: str, root: Path, read_file: ReadFileFunc) -> str:
    """Build a '# <path>' section containing that single file's content."""
    content = read_file(root / rel_path)
    return f"# {rel_path}\n\n```\n{content}\n```\n"


def build_markdown(
    tracked_files: list[str],
    filtered_files: list[str],
    root: Path,
    read_file: ReadFileFunc,
) -> str:
    """Assemble the full markdown output: structure, file contents, prompt.

    `read_file` is injected so this function stays independent of any actual
    filesystem access, which makes it trivial to test.
    """
    sections = [build_project_structure(tracked_files)]
    sections.extend(
        build_file_section(rel_path, root, read_file) for rel_path in filtered_files
    )
    sections.append("# Prompt\n\n\n")
    return "\n".join(sections)
