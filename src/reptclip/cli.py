"""Command-line entry point for ReptClip."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from reptclip.clipboard import copy_to_clipboard
from reptclip.config import read_config, write_default_config
from reptclip.file_reader import read_file_content
from reptclip.filters import filter_files
from reptclip.git_files import get_git_tracked_files
from reptclip.markdown_builder import build_markdown


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse CLI arguments. Kept separate from `run` so it's easy to test."""
    parser = argparse.ArgumentParser(
        prog="reptclip",
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
    parser.add_argument(
        "-p", "--preset",
        nargs="+",
        default=[],
        metavar="PRESET",
        help="Names of presets from reptclip-config.toml to apply.",
    )
    subparsers = parser.add_subparsers(dest="command")
    subparsers.add_parser(
        "config",
        help="Create a default reptclip-config.toml file in the current directory.",
    )
    return parser.parse_args(argv)


def run(argv: list[str] | None = None) -> int:
    """Run the full reptclip program flow. Returns a process exit code."""
    args = parse_args(argv)
    root = Path.cwd()

    if getattr(args, "command", None) == "config":
        config_path = write_default_config(root)
        print(f"Created config file at {config_path}")
        return 0

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

    config_include, config_exclude, config_presets = read_config(root)
    include_patterns = args.include + config_include
    exclude_patterns = args.exclude + config_exclude

    for preset_name in args.preset:
        matching_preset = next(
            (preset for preset in config_presets if preset["name"] == preset_name),
            None,
        )
        if matching_preset is None:
            print(f"Error: preset '{preset_name}' was not found in {root / 'reptclip-config.toml'}.", file=sys.stderr)
            return 1

        include_patterns.extend(matching_preset["include"])
        exclude_patterns.extend(matching_preset["exclude"])

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
