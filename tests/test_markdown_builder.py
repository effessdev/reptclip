from pathlib import Path

from cheapchatcontext.markdown_builder import build_markdown, build_project_structure


def fake_read_file(path: Path) -> str:
    return f"CONTENT OF {path.name}"


def test_build_project_structure_lists_all_files():
    result = build_project_structure(["a.py", "src/b.py"])
    assert result.startswith("# Project structure")
    assert "a.py" in result
    assert "src/b.py" in result


def test_build_markdown_includes_structure_files_and_prompt():
    tracked = ["a.py", "src/b.py"]
    filtered = ["a.py"]
    result = build_markdown(tracked, filtered, Path("/repo"), fake_read_file)

    assert "# Project structure" in result
    assert "# a.py" in result
    assert "CONTENT OF a.py" in result
    assert "# Prompt" in result
    # Only the filtered file should have its own content section.
    assert "# src/b.py" not in result


def test_build_markdown_with_no_filtered_files_still_has_structure_and_prompt():
    result = build_markdown(["a.py"], [], Path("/repo"), fake_read_file)
    assert "# Project structure" in result
    assert "# Prompt" in result
