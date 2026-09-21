from pathlib import Path

import reptclip.cli as cli
from reptclip.cli import run
from reptclip.cli_parser import parse_cli_args


def test_parse_cli_args_supports_hyphens_and_traditional_flags() -> None:
    args = parse_cli_args(["-i", "**/*.py", "--exclude", "src/secret.py", "-p", "docs", "--no-clipboard", "--prompt-tail"])
    assert args.include == ["**/*.py"]
    assert args.exclude == ["src/secret.py"]
    assert args.preset == ["docs"]
    assert args.copy_to_clipboard is False
    assert args.prompt_tail is True


def test_parse_cli_args_natural_syntax() -> None:
    args = parse_cli_args(["**/*.py", "AGENTS.md", "e", "src/secret.py", "p", "docs"])
    assert args.include == ["**/*.py", "AGENTS.md"]
    assert args.exclude == ["src/secret.py"]
    assert args.preset == ["docs"]


def test_parse_cli_args_interleaved_keywords() -> None:
    args = parse_cli_args(["-i", "file1", "file2", "--no-prompt-tail", "file3", "-o", "out.md", "-c"])
    assert args.include == ["file1", "file2", "file3"]
    assert args.prompt_tail is False
    assert args.output_file == "out.md"
    assert args.copy_to_clipboard is True


def test_init_command_creates_default_config(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)

    exit_code = run(["init"])

    assert exit_code == 0
    assert (tmp_path / "reptclip-config.toml").read_text(encoding="utf-8") == (
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


def test_run_applies_default_preset_and_overrides_with_selected_preset(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "reptclip-config.toml").write_text(
        '[[presets]]\n'
        'name = "default"\n'
        'include = ["src/**"]\n'
        'exclude = ["src/skip/**"]\n'
        'copy_to_clipboard = true\n'
        '\n'
        '[[presets]]\n'
        'name = "docs"\n'
        'include = ["docs/**"]\n'
        'exclude = ["docs/skip/**"]\n'
        'copy_to_clipboard = false\n'
    )

    monkeypatch.setattr(cli, "get_git_tracked_files", lambda root: ["README.md", "src/app.py", "docs/guide.md"])
    monkeypatch.setattr(cli, "read_file_content", lambda path: "")
    monkeypatch.setattr(cli, "build_markdown", lambda tracked, filtered, root, reader, **kwargs: "markdown")

    clipboard_called = []
    monkeypatch.setattr(cli, "copy_to_clipboard", lambda markdown: clipboard_called.append(True))

    captured: dict[str, list[str]] = {}

    def fake_filter_files(files, include_patterns, exclude_patterns):
        captured["include_patterns"] = include_patterns
        captured["exclude_patterns"] = exclude_patterns
        return files

    monkeypatch.setattr(cli, "filter_files", fake_filter_files)

    exit_code = run(["-i", "README.md", "-p", "docs"])

    assert exit_code == 0
    assert captured["include_patterns"] == ["src/**", "docs/**", "README.md"]
    assert captured["exclude_patterns"] == ["src/skip/**", "docs/skip/**"]
    assert clipboard_called == []
