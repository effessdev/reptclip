"""Reading include/exclude patterns from a reptclip-config.toml file."""

from __future__ import annotations

from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover - exercised on Python < 3.11
    import tomli as tomllib  # type: ignore[no-redef]

CONFIG_FILENAME = "reptclip-config.toml"
DEFAULT_CONFIG_TEMPLATE = (
    'include = ["AGENTS.md", "**/*.py"]\n'
    'exclude = []\n'
    '\n'
    '[[presets]]\n'
    'name = "all"\n'
    'include = ["**"]\n'
    'exclude = []\n'
)


def read_config(root: Path) -> tuple[list[str], list[str], list[dict[str, list[str]]]]:
    """Read config values from `reptclip-config.toml` in `root`.

    Returns `([], [], [])` if the file doesn't exist. The file, if present, is
    expected to look like:

        include = ["src/**/*.py"]
        exclude = ["src/generated/**"]

        [[presets]]
        name = "docs"
        include = ["docs/**/*.md"]
        exclude = ["docs/skip/**"]
    """
    config_path = root / CONFIG_FILENAME
    if not config_path.is_file():
        return [], [], []

    with config_path.open("rb") as f:
        data = tomllib.load(f)

    include = list(data.get("include", []))
    exclude = list(data.get("exclude", []))
    raw_presets = data.get("presets", [])
    presets: list[dict[str, list[str]]] = []

    for preset_data in raw_presets:
        if not isinstance(preset_data, dict):
            continue

        name = preset_data.get("name")
        if not isinstance(name, str) or not name:
            continue

        include_patterns = preset_data.get("include", [])
        exclude_patterns = preset_data.get("exclude", [])
        presets.append(
            {
                "name": name,
                "include": list(include_patterns),
                "exclude": list(exclude_patterns),
            }
        )

    return include, exclude, presets


def write_default_config(root: Path) -> Path:
    """Write a default `reptclip-config.toml` file to `root`."""
    config_path = root / CONFIG_FILENAME
    config_path.write_text(DEFAULT_CONFIG_TEMPLATE, encoding="utf-8")
    return config_path
