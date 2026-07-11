"""Command-line entry point for ReptClip (``ccc``)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from reptclip.clipboard import copy_to_clipboard
from reptclip.config import read_config
from reptclip.file_reader import read_file_content
from reptclip.filters import filter_files
from reptclip.git_files import get_git_tracked_files
from reptclip.markdown_builder import build_markdown


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse CLI arguments. Kept separate from `run` so it's easy to test."""
    parser = argparse.ArgumentParser(
        prog="ccc",
        description=(
            "Generate a Markdown snapshot of a git repository's structure and "
            "chosen files, and copy it straight to the clipboard."
        ),
    )
    parser.add_argument(
        "-i", "--include",
        nargs="+",
        default=[],
        metavar="PATTERN",
        help="Glob patterns of files to include (supports * and **).",
    )
    parser.add_argument(
        "-e", "--exclude",
        nargs="+",
        default=[],
        metavar="PATTERN",
        help="Glob patterns of files to exclude (supports * and **).",
    )
    return parser.parse_args(argv)


def run(argv: list[str] | None = None) -> int:
    """Run the full ccc program flow. Returns a process exit code."""
    args = parse_args(argv)
    root = Path.cwd()

    try:
        tracked_files = get_git_tracked_files(root)
    except FileNotFoundError:
        print("Error: git does not appear to be installed.", file=sys.stderr)
        return 1
    except Exception as exc:
        print(
            f"Error: could not list git-tracked files (is this a git repository?): {exc}",
            file=sys.stderr,
        )
        return 1

    if not tracked_files:
        print("No git-tracked files found in the current directory.", file=sys.stderr)
        return 1

    config_include, config_exclude = read_config(root)
    include_patterns = args.include + config_include
    exclude_patterns = args.exclude + config_exclude

    filtered_files = filter_files(tracked_files, include_patterns, exclude_patterns)

    markdown = build_markdown(tracked_files, filtered_files, root, read_file_content)

    try:
        copy_to_clipboard(markdown)
    except Exception as exc:
        print(f"Error: could not copy to clipboard: {exc}", file=sys.stderr)
        return 1

    print(
        f"Copied to clipboard: {len(filtered_files)} file(s) included, "
        f"{len(tracked_files)} file(s) in project structure, "
        f"{len(markdown)} characters total."
    )
    return 0


def main() -> None:
    sys.exit(run())


if __name__ == "__main__":
    main()
