import * as fs from "fs/promises";

const MAX_BYTES = 1024 * 1024; // 1 MB, same threshold as the CLI.

export interface SafeReadResult {
  skipped: boolean;
  reason?: string;
  content?: string;
}

/**
 * Reads a file's contents, but instead of throwing/erroring on files that
 * would bloat or break the output, returns a descriptive placeholder for
 * binaries and oversized files — matching the CLI's "automatic guards".
 */
export async function readFileSafe(absPath: string): Promise<SafeReadResult> {
  const stat = await fs.stat(absPath);

  if (stat.size > MAX_BYTES) {
    return {
      skipped: true,
      reason: `File skipped: exceeds 1 MB (${formatBytes(stat.size)}).`,
    };
  }

  const buffer = await fs.readFile(absPath);

  if (looksBinary(buffer)) {
    return { skipped: true, reason: "File skipped: appears to be binary." };
  }

  const content = decodeUtf8(buffer);
  if (content === undefined) {
    return {
      skipped: true,
      reason:
        "File skipped: not valid UTF-8 text (the file is probably in a legacy encoding).",
    };
  }

  return { skipped: false, content };
}

/**
 * NUL-byte sniff over the whole buffer. Sniffing only the first 8000 bytes
 * (the size of git's binary heuristic window) lets a file with a NUL past the
 * window through as text.
 */
function looksBinary(buffer: Buffer): boolean {
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Strict UTF-8 decode. `Buffer#toString("utf8")` silently turns every
 * invalid byte into U+FFFD, which is how a Windows-1251 file used to arrive in
 * the prompt as a wall of `�`; a file that is not valid UTF-8 is reported as
 * skipped instead.
 */
function decodeUtf8(buffer: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

/**
 * Streaming UTF-8 + NUL check for a file that is not going to be embedded
 * whole (grep results). Unlike `readFileSafe` there is no 1 MB embed cap: a
 * large text file can still be searched, it just cannot be pasted in full.
 */
export async function isUtf8TextFile(absPath: string): Promise<boolean> {
  let handle;
  try {
    handle = await fs.open(absPath, "r");
  } catch {
    return false;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.alloc(64 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      if (chunk.includes(0)) {
        return false;
      }
      decoder.decode(chunk, { stream: true });
    }
    decoder.decode();
    return true;
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Counts a file's raw lines (including blank lines), the same way the
 * "Project structure" listing annotates each path. Returns `undefined`
 * instead of a number for anything that can't be sensibly counted: missing
 * files, files over the same 1 MB threshold used for embedding, and binary
 * content (same NUL-byte sniff as `readFileSafe`).
 */
export async function countFileLines(
  absPath: string,
): Promise<number | undefined> {
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return undefined;
  }

  if (!stat.isFile() || stat.size > MAX_BYTES) {
    return undefined;
  }

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(absPath);
  } catch {
    return undefined;
  }

  if (looksBinary(buffer)) {
    return undefined;
  }

  const content = decodeUtf8(buffer);
  if (content === undefined) {
    return undefined;
  }
  if (content.length === 0) {
    return 0;
  }

  const matches = content.match(/\r\n|\r|\n/g);
  const newlineCount = matches ? matches.length : 0;
  const endsWithNewline = /(?:\r\n|\r|\n)$/.test(content);
  return endsWithNewline ? newlineCount : newlineCount + 1;
}
