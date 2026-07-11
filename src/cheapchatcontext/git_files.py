"""Listing files tracked by git."""

from __future__ import annotations

import subprocess
from pathlib import Path


def get_git_tracked_files(root: Path) -> list[str]:
    """Return relative, forward-slash paths of every file tracked by git in `root`.

    Uses ``git ls-files``, which reads git's index directly rather than walking
    the whole directory tree, so it stays fast even on large repositories and
    naturally skips ignored/untracked directories (e.g. build folders,
    virtualenvs) without ever visiting them.

    Raises:
        subprocess.CalledProcessError: if `root` is not inside a git repository
            or git is otherwise unable to list files.
        FileNotFoundError: if git is not installed.
    """
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=root,
        capture_output=True,
        check=True,
    )
    raw = result.stdout.decode("utf-8", errors="replace")
    if not raw:
        return []
    return [path for path in raw.split("\0") if path]
