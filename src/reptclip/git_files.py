"""Listing files in the working directory using pure Python."""

from __future__ import annotations

import os
from pathlib import Path

import pathspec


def get_git_tracked_files(root: Path) -> list[str]:
    """Return relative, forward-slash paths of every unignored file in `root`.

    This pure Python approach traverses the directory tree using `os.walk`,
    explicitly skipping the `.git` folder. It uses `pathspec` to dynamically
    prune directories and files that match the rules defined in the root
    `.gitignore` file.

    Raises:
        FileNotFoundError: if the `root` path does not exist.
    """
    # Parse the root .gitignore if it exists
    gitignore_path = root / ".gitignore"
    if gitignore_path.is_file():
        with gitignore_path.open("r", encoding="utf-8") as f:
            spec = pathspec.PathSpec.from_lines("gitwildmatch", f)
    else:
        # Fallback to an empty spec if no .gitignore is found
        spec = pathspec.PathSpec.from_lines("gitwildmatch", [])

    valid_files = []

    # Traverse the directory tree
    for dirpath, dirnames, filenames in os.walk(root):
        # Prevent traversal into the .git directory altogether
        if ".git" in dirnames:
            dirnames.remove(".git")

        # Calculate the path relative to the root directory
        rel_dir = Path(dirpath).relative_to(root)

        # Filter directories dynamically so we don't traverse ignored folders
        dirs_to_keep = []
        for d in dirnames:
            # Append a trailing slash to correctly test directory ignores in pathspec
            d_rel = (rel_dir / d).as_posix() + "/"
            if not spec.match_file(d_rel):
                dirs_to_keep.append(d)
        
        # Modify dirnames in-place to prune the os.walk tree
        dirnames[:] = dirs_to_keep

        # Filter and append valid files
        for f in filenames:
            f_rel = (rel_dir / f).as_posix()
            if not spec.match_file(f_rel):
                valid_files.append(f_rel)

    return valid_files
