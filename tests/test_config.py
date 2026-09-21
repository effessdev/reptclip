from pathlib import Path

from reptclip.config import read_config


def test_missing_config_returns_empty_list(tmp_path: Path):
    assert read_config(tmp_path) == []


def test_reads_presets(tmp_path: Path):
    (tmp_path / "reptclip-config.toml").write_text(
        '[[presets]]\n'
        'name = "default"\n'
        'include = ["AGENTS.md"]\n'
        'exclude = []\n'
        'output = ""\n'
        'clipboard = true\n'
        'prompt_tail = true\n'
        '\n'
        '[[presets]]\n'
        'name = "docs"\n'
        'include = ["docs/**/*.md"]\n'
        'exclude = ["docs/skip/**"]\n'
        'output = "out.md"\n'
        'clipboard = false\n'
        'prompt_tail = false\n'
    )
    presets = read_config(tmp_path)
    assert presets == [
        {
            "name": "default",
            "include": ["AGENTS.md"],
            "exclude": [],
            "output": None,
            "clipboard": True,
            "prompt_tail": True,
        },
        {
            "name": "docs",
            "include": ["docs/**/*.md"],
            "exclude": ["docs/skip/**"],
            "output": "out.md",
            "clipboard": False,
            "prompt_tail": False,
        },
    ]


def test_preset_optional_fields_omitted(tmp_path: Path):
    (tmp_path / "reptclip-config.toml").write_text(
        '[[presets]]\n'
        'name = "minimal"\n'
        'include = ["a.py"]\n'
    )
    presets = read_config(tmp_path)
    assert presets == [
        {
            "name": "minimal",
            "include": ["a.py"],
            "exclude": [],
        }
    ]
