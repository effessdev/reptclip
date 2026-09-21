"""Custom CLI argument parser supporting readable natural syntax with optional hyphen flags."""

from __future__ import annotations

import dataclasses
from typing import List, Optional


@dataclasses.dataclass
class ParsedArgs:
    include: List[str] = dataclasses.field(default_factory=list)
    exclude: List[str] = dataclasses.field(default_factory=list)
    preset: List[str] = dataclasses.field(default_factory=list)
    output_file: Optional[str] = None
    copy_to_clipboard: Optional[bool] = None
    prompt_tail: Optional[bool] = None
    command: Optional[str] = None


INCLUDE_KEYWORDS = {"i", "include"}
EXCLUDE_KEYWORDS = {"e", "exclude"}
PRESET_KEYWORDS = {"p", "preset"}
OUTPUT_KEYWORDS = {"o", "output"}
CLIPBOARD_ON_KEYWORDS = {"c", "clipboard"}
CLIPBOARD_OFF_KEYWORDS = {"nc", "no-clipboard"}
PROMPT_TAIL_ON_KEYWORDS = {"pt", "prompt-tail"}
PROMPT_TAIL_OFF_KEYWORDS = {"npt", "no-prompt-tail"}


def parse_cli_args(argv: List[str] | None = None) -> ParsedArgs:
    """Parse raw CLI token list into `ParsedArgs` structure.

    Strips optional leading hyphens so `-i`, `--include`, `i`, and `include`
    behave identically.
    """
    if argv is None:
        import sys

        argv = sys.argv[1:]

    args = ParsedArgs()

    if not argv:
        return args

    # Check for subcommand (e.g. `init`)
    if argv[0] == "init":
        args.command = "init"
        return args

    current_mode = "include"

    for token in argv:
        clean_token = token.lstrip("-") if token.startswith("-") else token

        if clean_token in INCLUDE_KEYWORDS:
            current_mode = "include"
            continue
        elif clean_token in EXCLUDE_KEYWORDS:
            current_mode = "exclude"
            continue
        elif clean_token in PRESET_KEYWORDS:
            current_mode = "preset"
            continue
        elif clean_token in OUTPUT_KEYWORDS:
            current_mode = "output"
            continue
        elif clean_token in CLIPBOARD_ON_KEYWORDS:
            args.copy_to_clipboard = True
            continue
        elif clean_token in CLIPBOARD_OFF_KEYWORDS:
            args.copy_to_clipboard = False
            continue
        elif clean_token in PROMPT_TAIL_ON_KEYWORDS:
            args.prompt_tail = True
            continue
        elif clean_token in PROMPT_TAIL_OFF_KEYWORDS:
            args.prompt_tail = False
            continue

        # Accumulate values according to active mode
        if current_mode == "include":
            args.include.append(token)
        elif current_mode == "exclude":
            args.exclude.append(token)
        elif current_mode == "preset":
            args.preset.append(token)
        elif current_mode == "output":
            args.output_file = token

    return args
