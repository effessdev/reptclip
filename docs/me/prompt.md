Create a Python cross-platform (Windows, MacOS, Linux) CLI application named CheapChatContext. It should be packaged properly because it has to be published on PyPI. We should be able to run the app by running the command `ccc`​ in the terminal after installing it through `pip`​.

# What the app does

This app is used to give context about our repositories to an LLM. It scans the repository (honouring `.gitignore`​ files), generates a properly formatted Markdown text containing the project structure and other relevant files (which can be specified by the user), and copies the generated text to the clipboard. It should be very fast.

# How to implement

The app should only care about the files that are tracked by git. First, get all files (paths) tracked by git. This process should be very fast and efficient, so you have to skip directories as you read them rather than reading everything first and skipping later. Create a function that does this, and make it independent and easily testable.

This can be used to construct the directory structure. After this, we have to add other files. For this, we can either use the CLI or a `ccc-config.toml`​ file. No file is included by default; we have to explicitly include them while running the app or using the config file. Files to include or exclude are specified using glob patterns (only `*`​ and `**`​ are supported). Example terminal commands:

```
ccc -i src/**/*.cpp tests/**/*.cpp docs/ -e tests/VeryLargeTest.cpp
```

This includes all .cpp files in src, everything in docs (recursively), and tests, while excluding a specific test file. We should be able to use quotes when the file name contains spaces.

Other than this, if a `ccc-config.toml`​ is found in the folder where we are running the command from (the root project directory), it will also process the `include`​ and `exclude`​ lists in that file. Both should work identically. So, create a function which gives the filtered files from the file paths using include and exclude glob patterns. Combine the include and exclude patterns of CLI and config file, and feed them to that function. This function should be easily testable and independent.

Finally, the output is copied to the user's clipboard. The app doesn't have to support any features that I haven't explicitly mentioned, like output to a file or something.

# Coding rules

The code should be written in simple and concise syntax. Try to make the individual functions testable (but you do not have to test them) and independent. Do not use a single big file.

# Config file

It should be really simple. It just need to support two lists for include and exclude patterns.

# Program flow

- Start
- Get a list of all files tracked by git in the directory from which the script is launched from (relative paths; using custom function)
- Get include and exclude patterns from CLI
- Get include and exclude patterns from config file using custom function
- Combine the include patterns from CLI and config into a single ilst
- Do the same for exclude patterns
- Get the filtered file list (relative file paths) by feeding the relative file paths we got before, include patterns and exclude patterns
- Build the markdown output, you can use the custom function for reading files for this
- Copy the output to the clipboard
- Show a concise single line output for the user which tells how many files were included, total length of the output in chars, etc.

# Example outputs

## Case 1: No configuration files, no CLI arguments

### Command

```
ccc
```

### Example output

````
# Project structure

```
docs/README.md
src/CMakeLists.txt
src/main.cpp
src/ProjectScanner.cpp
src/ProjectScanner.h
tests/CMakeLists.txt
tests/ProjectScannerTests.cpp
.gitignore
CMakeLists
```

# Prompt


````

The user can paste this to a chatbot and type their prompt right away.

## Case 2: No configuration files, CLI arguments

### Command

```
ccc -i src/main.cpp
```

### Example output

````
# Project structure

```
docs/README.md
src/CMakeLists.txt
src/main.cpp
src/ProjectScanner.cpp
src/ProjectScanner.h
tests/CMakeLists.txt
tests/ProjectScannerTests.cpp
.gitignore
CMakeLists
```

# src/main.cpp

```
#include <iostream>
#include <string>

int main() {
    std::string message = "Hello, World!";
    std::cout << message << std::endl;
    return 0;
}
```

# Prompt


````

## Case 3: Configuration files and CLI arguments

This works exactly the same, because the contents in the config and CLI arguments are added to the same include and exclude lists and processed in a single function that doesn't know about the origin of them.

# Other features

Do not read the files from the main function. Create a function that reads the files. This function should check whether the file is a binary file or the file is extremely large for a source file. If there is something like that, instead of throwing an error, output something like "File skipped due to binary extension.", "File skipped due to large size.", etc. The main file doesn't need to know this problem, it will gracefully read this as the contents of this file.

# Important

Do not make the app tightly coupled. Try to make each individual functions testable and independent.
