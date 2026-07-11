from pathlib import Path

from cheapchatcontext.file_reader import MAX_FILE_SIZE_BYTES, read_file_content


def test_reads_normal_text_file(tmp_path: Path):
    f = tmp_path / "main.py"
    f.write_text("print('hello')\n")
    assert read_file_content(f) == "print('hello')\n"


def test_missing_file(tmp_path: Path):
    assert read_file_content(tmp_path / "nope.py") == "File skipped: not found."


def test_binary_extension_skipped(tmp_path: Path):
    f = tmp_path / "image.png"
    f.write_bytes(b"\x89PNG\r\n")
    assert read_file_content(f) == "File skipped due to binary extension."


def test_large_file_skipped(tmp_path: Path):
    f = tmp_path / "big.txt"
    f.write_bytes(b"a" * (MAX_FILE_SIZE_BYTES + 1))
    assert read_file_content(f) == "File skipped due to large size."


def test_binary_content_without_known_extension_skipped(tmp_path: Path):
    f = tmp_path / "mystery.dat"
    f.write_bytes(b"abc\x00def")
    assert read_file_content(f) == "File skipped due to binary content."
