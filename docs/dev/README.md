# Developer documentation

Welcome! This guide will walk you through setting up your environment, running tests, making code changes, and contributing to the project step-by-step.

## Prerequisites

Make sure you have **Python 3.8+** and `pip` installed on your system.

## Step 1: Set Up Your Environment

Using a virtual environment keeps this project's dependencies isolated from the rest of your system.

### Linux & macOS (Bash / Zsh)

Open your terminal in the root directory of the project and run:

```bash
# 1. Create a virtual environment named 'venv'
python3 -m venv venv

# 2. Activate the environment
source venv/bin/activate
```

### Windows

Open your terminal in the root directory of the project and run the commands for your shell:

#### Option A: PowerShell

```powershell
# 1. Create the virtual environment
python -m venv venv

# 2. Activate the environment
.\venv\Scripts\Activate.ps1
```

> **PowerShell Script Error?** If you receive a script execution policy error when activating, run `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process` in your session, then try activating again.

#### Option B: Command Prompt (CMD)

```cmd
:: 1. Create the virtual environment
python -m venv venv

:: 2. Activate the environment
venv\Scripts\activate.bat
```

---

- **Verify activation:** Your terminal prompt will display `(venv)` at the start of the line.
- **Exit the environment:** Type `deactivate` in your terminal when you are finished.

## Step 2: Install the Package & Development Dependencies

To contribute code, you need to install the project in **editable mode** alongside development tools (like `pytest`).

Run the following command in your activated environment:

```bash
pip install -e ".[dev]"
```

> **Note:** The `-e` flag ("editable") ensures that any code changes you make locally are reflected immediately without needing to reinstall the package.

## Step 3: Making Changes & Development Workflow

Follow this general workflow when adding features or fixing bugs:

### 1. Create a New Branch

Keep your work organized by creating a dedicated git branch for your feature or fix:

```bash
git checkout -b feature/my-new-feature
```

### 2. Make Your Code Edits

Modify or add files inside the project repository using your preferred code editor.

### 3. Add Tests for Your Changes

If you are adding a feature or fixing a bug, add corresponding tests inside the `tests/` directory to ensure long-term stability.

## Step 4: Run the Tests

Before committing your changes, run the test suite to make sure everything passes without breaking existing functionality.

```bash
pytest
```

### Useful Pytest Options:

- Run a specific test file: `pytest tests/test_filename.py`
- Stop on the first failure: `pytest -x`
- Show verbose output: `pytest -v`

## Step 5: Submitting Your Contribution

1. **Stage and commit your changes:**

   ```bash
   git add .
   git commit -m "Add short, descriptive summary of changes"
   ```

2. **Push your branch to GitHub:**

   ```bash
   git push origin feature/my-new-feature
   ```

3. **Open a Pull Request (PR):** Navigate to the project's repository on GitHub and click **Compare & pull request** to submit your changes for code review!

## Troubleshooting & FAQ

| Issue                          | Solution                                                                                  |
| :----------------------------- | :---------------------------------------------------------------------------------------- |
| **`pytest` is not recognized** | Ensure your virtual environment `(venv)` is active and you ran `pip install -e ".[dev]"`. |
| **`python` command not found** | Try using `python3` instead, or verify Python is added to your system `PATH`.             |
| **Changes not showing up**     | Verify that `(venv)` is active and that the package was installed with the `-e` flag.     |
