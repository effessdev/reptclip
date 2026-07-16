from pathlib import Path

from reptclip.config import read_config


def test_missing_config_returns_empty_lists(tmp_path: Path):
    assert read_config(tmp_path) == ([], [], [])


def test_reads_include_and_exclude(tmp_path: Path):
    (tmp_path / "reptclip-config.toml").write_text(
        'include = ["src/**/*.py", "docs/"]\n'
        'exclude = ["src/generated/**"]\n'
    )
    include, exclude, presets = read_config(tmp_path)
    assert include == ["src/**/*.py", "docs/"]
    assert exclude == ["src/generated/**"]
    assert presets == []


def test_reads_presets(tmp_path: Path):
    (tmp_path / "reptclip-config.toml").write_text(
        '[[presets]]\n'
        'name = "docs"\n'
        'include = ["docs/**/*.md"]\n'
        'exclude = ["docs/skip/**"]\n'
        '\n'
        '[[presets]]\n'
        'name = "tests"\n'
        'include = ["tests/**"]\n'
        'exclude = []\n'
    )
    include, exclude, presets = read_config(tmp_path)
    assert include == []
    assert exclude == []
    assert presets == [
        {"name": "docs", "include": ["docs/**/*.md"], "exclude": ["docs/skip/**"]},
        {"name": "tests", "include": ["tests/**"], "exclude": []},
    ]


def test_missing_keys_default_to_empty_lists(tmp_path: Path):
    (tmp_path / "reptclip-config.toml").write_text('include = ["a.py"]\n')
    include, exclude, presets = read_config(tmp_path)
    assert include == ["a.py"]
    assert exclude == []
    assert presets == []
