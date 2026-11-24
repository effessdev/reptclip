// A green run with zero tests is not a pass: `node --test` exits 0 when it finds
// nothing, so a broken discovery pattern (or a deleted test tree) would publish
// a release. This runs the suite, reads the TAP plan the runner prints, and
// refuses a run that executed fewer tests than the floor.
//
// It spawns the runner itself instead of relying on shell redirection, because
// PowerShell 5 writes `>` as UTF-16 and the parse would fail on the plan line.
//
// The floor is deliberately explicit. Lowering it is a decision someone has to
// make in a review, not something that happens by accident.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

/**
 * Tests the suite is expected to run. main runs 138; the floor sits below it
 * so an accidental discovery failure is caught without pinning the exact count.
 * Raise it when the suite grows.
 */
const MIN_TESTS = 130;

/**
 * A few tests are platform-gated (NTFS alternate data streams skip on Linux,
 * the POSIX filename test skips on Windows), so a small number is normal.
 * Marking whole files skipped to go green would exceed this.
 */
const MAX_SKIPPED = 10;

/**
 * A test file that terminates its own process hides every test after it: the
 * runner only counts what it saw, so the plan shrinks by a few and the floor's
 * slack absorbs it. Measured: a file whose second test calls `process.exit(0)`
 * left the run green with one test missing from the plan.
 */
const FORBIDDEN_IN_TESTS = /process\.(exit|abort|kill)\s*\(/;

const require = createRequire(import.meta.url);
let cli;
try {
  const tsxPackage = require.resolve("tsx/package.json");
  cli = path.join(path.dirname(tsxPackage), "dist", "cli.mjs");
} catch {
  console.error("tsx is not installed; run npm ci first");
  process.exit(2);
}

function findTests(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findTests(full, found);
    } else if (/\.test\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

let offenders = 0;
for (const file of findTests(process.cwd())) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (FORBIDDEN_IN_TESTS.test(line)) {
      console.error(
        `${path.relative(process.cwd(), file)}:${index + 1}: a test must not ` +
          "terminate the process; it hides the remaining tests in the file",
      );
      offenders += 1;
    }
  });
}
if (offenders > 0) {
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [cli, "--test", "--test-reporter=tap"],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

child.on("close", (code) => {
  process.stdout.write(stdout);
  process.stderr.write(stderr);

  const plan = /^1\.\.(\d+)\s*$/m.exec(stdout);
  if (plan === null) {
    console.error(
      "no TAP plan in the runner output: the test command found no tests. " +
        "This is not a pass.",
    );
    process.exit(1);
  }

  const total = Number(plan[1]);
  if (!Number.isFinite(total) || total < MIN_TESTS) {
    console.error(
      `only ${total} tests ran, the suite expects at least ${MIN_TESTS}. ` +
        "If tests were removed on purpose, lower MIN_TESTS in this file.",
    );
    process.exit(1);
  }

  const failed = /^# fail (\d+)\s*$/m.exec(stdout);
  if (failed !== null && Number(failed[1]) > 0) {
    console.error(`${failed[1]} test(s) failed`);
    process.exit(1);
  }

  const skipped = /^# skipped (\d+)\s*$/m.exec(stdout);
  if (skipped !== null && Number(skipped[1]) > MAX_SKIPPED) {
    console.error(
      `${skipped[1]} tests skipped, at most ${MAX_SKIPPED} are expected from ` +
        "platform gates. Skipped tests do not prove anything.",
    );
    process.exit(1);
  }

  console.log(
    `TAP plan: ${total} tests, ${skipped === null ? 0 : skipped[1]} skipped, none failed (floor ${MIN_TESTS})`,
  );
  process.exit(code ?? 1);
});
