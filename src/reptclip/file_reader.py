"""Reading file contents for markdown output, with binary/size guards.

Callers never need to handle errors themselves: unreadable, binary, or
oversized files simply produce a short placeholder string instead of raising.
"""

from __future__ import annotations

from pathlib import Path

MAX_FILE_SIZE_BYTES = 1_000_000  # 1 MB

# Extensions that are essentially always binary, checked before touching
# the file at all (cheap and avoids opening obvious non-text files).
BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff",
    ".pdf", ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".xz",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".class", ".jar",
    ".pyc", ".pyo", ".o", ".obj", ".a", ".lib",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".flac",
    ".db", ".sqlite", ".sqlite3", ".pkl", ".parquet",
}


def _looks_binary(path: Path, sample_size: int = 8192) -> bool:
    """Heuristically detect binary content by sniffing for null bytes."""
    try:
        with path.open("rb") as f:
            chunk = f.read(sample_size)
    except OSError:
        return False
    return b"\0" in chunk


def read_file_content(path: Path) -> str:
    """Return the text content of `path`.

    Instead of raising, returns a short placeholder message when the file is
    missing, binary, or too large to include.
    """
    if not path.is_file():
        return "File skipped: not found."

    if path.suffix.lower() in BINARY_EXTENSIONS:
        return "File skipped due to binary extension."

    try:
        size = path.stat().st_size
    except OSError:
        return "File skipped: unable to read file size."

    if size > MAX_FILE_SIZE_BYTES:
        return "File skipped due to large size."

    if _looks_binary(path):
        return "File skipped due to binary content."

    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return f"File skipped due to read error: {exc}"
