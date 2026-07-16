from pathlib import Path

from reptclip.cli import run


def test_config_command_creates_default_config(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)

    exit_code = run(["config"])

    assert exit_code == 0
    assert (tmp_path / "reptclip-config.toml").read_text(encoding="utf-8") == (
        'include = ["AGENTS.md", "**/*.py"]\n'
        "exclude = []\n"
    )
