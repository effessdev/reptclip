"""Reading include/exclude patterns from a reptclip-config.toml file."""

from __future__ import annotations

from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover - exercised on Python < 3.11
    import tomli as tomllib  # type: ignore[no-redef]

CONFIG_FILENAME = "reptclip-config.toml"
DEFAULT_CONFIG_TEMPLATE = 'include = ["AGENTS.md", "**/*.py"]\nexclude = []\n'


def read_config(root: Path) -> tuple[list[str], list[str]]:
    """Read the `include` and `exclude` lists from `reptclip-config.toml` in `root`.

    Returns `([], [])` if the file doesn't exist. The file, if present, is
    expected to look like:

        include = ["src/**/*.py"]
        exclude = ["src/generated/**"]
    """
    config_path = root / CONFIG_FILENAME
    if not config_path.is_file():
        return [], []

    with config_path.open("rb") as f:
        data = tomllib.load(f)

    include = list(data.get("include", []))
    exclude = list(data.get("exclude", []))
    return include, exclude


def write_default_config(root: Path) -> Path:
    """Write a default `reptclip-config.toml` file to `root`."""
    config_path = root / CONFIG_FILENAME
    config_path.write_text(DEFAULT_CONFIG_TEMPLATE, encoding="utf-8")
    return config_path
