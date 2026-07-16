from pathlib import Path

import reptclip.cli as cli
from reptclip.cli import run


def test_config_command_creates_default_config(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)

    exit_code = run(["config"])

    assert exit_code == 0
    assert (tmp_path / "reptclip-config.toml").read_text(encoding="utf-8") == (
        'include = ["AGENTS.md", "**/*.py"]\n'
        "exclude = []\n"
        "\n"
        '[[presets]]\n'
        'name = "all"\n'
        'include = ["**"]\n'
        'exclude = []\n'
    )


def test_run_combines_selected_preset_patterns(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "reptclip-config.toml").write_text(
        'include = ["src/**"]\n'
        'exclude = ["src/skip/**"]\n'
        '\n'
        '[[presets]]\n'
        'name = "docs"\n'
        'include = ["docs/**"]\n'
        'exclude = ["docs/skip/**"]\n'
    )

    monkeypatch.setattr(cli, "get_git_tracked_files", lambda root: ["README.md", "src/app.py", "docs/guide.md"])
    monkeypatch.setattr(cli, "read_file_content", lambda path: "")
    monkeypatch.setattr(cli, "copy_to_clipboard", lambda markdown: None)
    monkeypatch.setattr(cli, "build_markdown", lambda tracked, filtered, root, reader: "markdown")

    captured: dict[str, list[str]] = {}

    def fake_filter_files(files, include_patterns, exclude_patterns):
        captured["include_patterns"] = include_patterns
        captured["exclude_patterns"] = exclude_patterns
        return files

    monkeypatch.setattr(cli, "filter_files", fake_filter_files)

    exit_code = run(["-i", "README.md", "-p", "docs"])

    assert exit_code == 0
    assert captured["include_patterns"] == ["README.md", "src/**", "docs/**"]
    assert captured["exclude_patterns"] == ["src/skip/**", "docs/skip/**"]
