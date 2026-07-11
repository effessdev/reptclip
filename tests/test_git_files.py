import subprocess
from pathlib import Path

import pytest

from cheapchatcontext.git_files import get_git_tracked_files


@pytest.fixture
def git_repo(tmp_path: Path) -> Path:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=tmp_path, check=True)

    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print('hi')\n")
    (tmp_path / "README.md").write_text("# Readme\n")
    (tmp_path / "untracked.txt").write_text("not added\n")

    subprocess.run(["git", "add", "src/main.py", "README.md"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=tmp_path, check=True)
    return tmp_path


def test_returns_only_tracked_files(git_repo: Path):
    files = get_git_tracked_files(git_repo)
    assert sorted(files) == ["README.md", "src/main.py"]


def test_untracked_files_excluded(git_repo: Path):
    files = get_git_tracked_files(git_repo)
    assert "untracked.txt" not in files


def test_non_git_directory_raises(tmp_path: Path):
    with pytest.raises(subprocess.CalledProcessError):
        get_git_tracked_files(tmp_path)


def test_empty_repo_returns_empty_list(tmp_path: Path):
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    assert get_git_tracked_files(tmp_path) == []
