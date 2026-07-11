from pathlib import Path

from reptclip.config import read_config


def test_missing_config_returns_empty_lists(tmp_path: Path):
    assert read_config(tmp_path) == ([], [])


def test_reads_include_and_exclude(tmp_path: Path):
    (tmp_path / "ccc-config.toml").write_text(
        'include = ["src/**/*.py", "docs/"]\n'
        'exclude = ["src/generated/**"]\n'
    )
    include, exclude = read_config(tmp_path)
    assert include == ["src/**/*.py", "docs/"]
    assert exclude == ["src/generated/**"]


def test_missing_keys_default_to_empty_lists(tmp_path: Path):
    (tmp_path / "ccc-config.toml").write_text('include = ["a.py"]\n')
    include, exclude = read_config(tmp_path)
    assert include == ["a.py"]
    assert exclude == []
