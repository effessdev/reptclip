"""Cross-platform clipboard access (Windows, macOS, Linux)."""

from __future__ import annotations

import pyperclip


def copy_to_clipboard(text: str) -> None:
    """Copy `text` to the system clipboard."""
    pyperclip.copy(text)
