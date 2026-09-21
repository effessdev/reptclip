"""Command-line entry point for ReptClip."""

from __future__ import annotations

import argparse
import inspect
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
        "init",
        help="Create a default reptclip-config.toml file in the current directory.",
    )
    return parser.parse_args(argv)


def run(argv: list[str] | None = None) -> int:
    """Run the full reptclip program flow. Returns a process exit code."""
    args = parse_args(argv)
    root = Path.cwd()

    if getattr(args, "command", None) == "init":
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

    config_presets = read_config(root)
    presets_by_name = {p["name"]: p for p in config_presets}

    # Determine order of presets to apply (default first if present, then CLI presets)
    presets_to_apply = []
    if "default" in presets_by_name:
        presets_to_apply.append(presets_by_name["default"])

    for preset_name in args.preset:
        if preset_name not in presets_by_name:
            print(f"Error: preset '{preset_name}' was not found in {root / 'reptclip-config.toml'}.", file=sys.stderr)
            return 1
        presets_to_apply.append(presets_by_name[preset_name])

    # Merge configuration options sequentially across presets
    include_patterns: list[str] = []
    exclude_patterns: list[str] = []
    output_file: str | None = None
    copy_to_clipboard_val: bool = True
    prompt_tail_val: bool = True

    for preset in presets_to_apply:
        include_patterns.extend(preset.get("include", []))
        exclude_patterns.extend(preset.get("exclude", []))

        if "output_file" in preset:
            output_file = preset["output_file"]
        if "copy_to_clipboard" in preset:
            copy_to_clipboard_val = preset["copy_to_clipboard"]
        if "prompt_tail" in preset:
            prompt_tail_val = preset["prompt_tail"]

    # Append CLI patterns over preset rules
    include_patterns.extend(args.include)
    exclude_patterns.extend(args.exclude)

    filtered_files = filter_files(tracked_files, include_patterns, exclude_patterns)

    if "prompt_tail" in inspect.signature(build_markdown).parameters:
        markdown = build_markdown(
            tracked_files,
            filtered_files,
            root,
            read_file_content,
            prompt_tail=prompt_tail_val,
        )
    else:
        markdown = build_markdown(tracked_files, filtered_files, root, read_file_content)

    # Optionally write to file if configured
    if output_file:
        try:
            out_path = Path(output_file)
            if not out_path.is_absolute():
                out_path = Path.cwd() / out_path
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(markdown, encoding="utf-8")
            print(f"Wrote output to {out_path}")
        except Exception as exc:
            print(f"Error: could not write output file: {exc}", file=sys.stderr)
            return 1

    # Optionally copy to clipboard
    if copy_to_clipboard_val:
        try:
            copy_to_clipboard(markdown)
        except Exception as exc:
            print(f"Error: could not copy to clipboard: {exc}", file=sys.stderr)
            return 1

    status_parts = []
    if copy_to_clipboard_val:
        status_parts.append("Copied to clipboard")
    if output_file:
        status_parts.append("Wrote to file")

    status_note = ", ".join(status_parts) if status_parts else "Generated output"

    print(
        f"{status_note}: {len(filtered_files)} file(s) included, "
        f"{len(tracked_files)} file(s) in project structure, "
        f"{len(markdown)} characters total."
    )
    return 0


def main() -> None:
    sys.exit(run())


if __name__ == "__main__":
    main()
