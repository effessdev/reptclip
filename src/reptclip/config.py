"""Reading presets from a reptclip-config.toml file."""

from __future__ import annotations

from pathlib import Path
from typing import Any

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover - exercised on Python < 3.11
    import tomli as tomllib  # type: ignore[no-redef]

CONFIG_FILENAME = "reptclip-config.toml"
DEFAULT_CONFIG_TEMPLATE = (
    '[[presets]]\n'
    'name = "default"\n'
    'include = ["AGENTS.md"]\n'
    'exclude = []\n'
    'output_file = ""  # relative path to write the output (leave empty to skip)\n'
    'copy_to_clipboard = true\n'
    'prompt_tail = true\n'
    '\n'
    '[[presets]]\n'
    'name = "all"\n'
    'include = ["**"]\n'
    'exclude = []\n'
)


def read_config(root: Path) -> list[dict[str, Any]]:
    """Read presets from `reptclip-config.toml` in `root`.

    Returns an empty list if the file doesn't exist.
    """
    config_path = root / CONFIG_FILENAME
    if not config_path.is_file():
        return []

    with config_path.open("rb") as f:
        data = tomllib.load(f)

    raw_presets = data.get("presets", [])
    presets: list[dict[str, Any]] = []

    for preset_data in raw_presets:
        if not isinstance(preset_data, dict):
            continue

        name = preset_data.get("name")
        if not isinstance(name, str) or not name:
            continue

        preset: dict[str, Any] = {
            "name": name,
            "include": list(preset_data.get("include", [])),
            "exclude": list(preset_data.get("exclude", [])),
        }

        if "output_file" in preset_data:
            out = preset_data.get("output_file")
            preset["output_file"] = out if isinstance(out, str) and out else None

        if "copy_to_clipboard" in preset_data:
            preset["copy_to_clipboard"] = bool(preset_data.get("copy_to_clipboard"))

        if "prompt_tail" in preset_data:
            preset["prompt_tail"] = bool(preset_data.get("prompt_tail"))

        presets.append(preset)

    return presets


def write_default_config(root: Path) -> Path:
    """Write a default `reptclip-config.toml` file to `root`."""
    config_path = root / CONFIG_FILENAME
    config_path.write_text(DEFAULT_CONFIG_TEMPLATE, encoding="utf-8")
    return config_path
