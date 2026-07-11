from reptclip.filters import filter_files, matches_any


def test_no_include_patterns_returns_nothing():
    assert filter_files(["a.py", "b.py"], [], []) == []


def test_exact_match():
    files = ["src/main.cpp", "src/util.h", "docs/readme.md"]
    assert filter_files(files, ["src/main.cpp"], []) == ["src/main.cpp"]


def test_single_star_matches_within_one_segment_only():
    files = ["src/main.cpp", "src/a/main.cpp"]
    assert filter_files(files, ["src/*.cpp"], []) == ["src/main.cpp"]


def test_double_star_matches_nested_dirs():
    files = ["src/a/b.cpp", "src/a.cpp", "tests/a/b.cpp"]
    result = filter_files(files, ["src/**/*.cpp"], [])
    assert set(result) == {"src/a/b.cpp", "src/a.cpp"}


def test_double_star_matches_zero_or_more_dirs_anywhere():
    files = ["a.py", "x/a.py", "x/y/a.py", "a.txt"]
    result = filter_files(files, ["**/*.py"], [])
    assert set(result) == {"a.py", "x/a.py", "x/y/a.py"}


def test_trailing_slash_matches_directory_recursively():
    files = ["docs/readme.md", "docs/guides/setup.md", "src/main.py"]
    result = filter_files(files, ["docs/"], [])
    assert set(result) == {"docs/readme.md", "docs/guides/setup.md"}


def test_exclude_removes_from_included_set():
    files = ["tests/a.cpp", "tests/VeryLargeTest.cpp"]
    result = filter_files(files, ["tests/**/*.cpp", "tests/*.cpp"], ["tests/VeryLargeTest.cpp"])
    assert result == ["tests/a.cpp"]

    # Simpler, matching the example from the spec.
    files = ["src/a.cpp", "tests/a.cpp", "tests/VeryLargeTest.cpp", "docs/readme.md"]
    result = filter_files(
        files,
        ["src/**/*.cpp", "tests/**/*.cpp", "docs/"],
        ["tests/VeryLargeTest.cpp"],
    )
    assert set(result) == {"src/a.cpp", "tests/a.cpp", "docs/readme.md"}


def test_matches_any_normalizes_windows_separators():
    assert matches_any("src\\main.cpp", ["src/*.cpp"])
