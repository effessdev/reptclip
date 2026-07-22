# Publishing

## 1. Update the version in pyproject.toml

Manually update the version number in `pyproject.toml`. The version is listed under `project`.

## 2. Build the package

```bash
hatch build
```

## 3. Publish to PyPI

You will need a PyPI API token.

```bash
hatch publish
```

When asked for the username, type `__token__` (including underscores).

## 4. Tag

```bash
git tag `v<MAJOR>.<MINOR>.<PATCH>`
git push --tags
```
