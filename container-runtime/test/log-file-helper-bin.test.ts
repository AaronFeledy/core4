import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const decoder = new TextDecoder();
const text = (value: Uint8Array): string => decoder.decode(value);
const logFileHelperSourcePath = new URL("../src/log-file-helper-bin.ts", import.meta.url).pathname;

const objectField = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Object.entries(value).find(([name]) => name === key)?.[1]
    : undefined;

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
};

const readProcessLine = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buffer: string },
): Promise<unknown> => {
  while (true) {
    const newline = state.buffer.indexOf("\n");
    if (newline >= 0) {
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      return JSON.parse(line);
    }
    const result = await reader.read();
    if (result.done === true) return undefined;
    state.buffer += text(result.value);
  }
};

const helperLines = async (commands: ReadonlyArray<unknown>): Promise<ReadonlyArray<unknown>> => {
  const helperSource = await readFile(logFileHelperSourcePath, "utf8");
  const proc = Bun.spawn([process.execPath, "--eval", helperSource], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const command of commands) proc.stdin.write(`${JSON.stringify(command)}\n`);
  proc.stdin.end();
  const output = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return output
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
};

const helperCleanupLine = async (path: string): Promise<unknown> => {
  const helperSource = await readFile(logFileHelperSourcePath, "utf8");
  const proc = Bun.spawn([process.execPath, "--eval", helperSource, "cleanup", path], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.end();
  const output = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return JSON.parse(output.trim());
};

describe("log file helper process", () => {
  test("uses real file handles for fstat and positional reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-log-helper-"));
    try {
      const file = join(dir, "app.log");
      await writeFile(file, "alpha\nbeta\n");
      const lines = await helperLines([
        { op: "open", path: file },
        { op: "read", offset: "6", maxBytes: 4 },
        { op: "fstat" },
        { op: "close" },
        { op: "fstat" },
      ]);
      const readBytes = objectField(lines[1], "bytes");

      expect(Buffer.from(typeof readBytes === "string" ? readBytes : "", "base64").toString("utf8")).toBe(
        "beta",
      );
      expect(objectField(objectField(lines[2], "stat"), "size")).toBe("11");
      expect(objectField(lines[4], "ok")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps reading the opened inode after path rotation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-log-helper-"));
    try {
      const file = join(dir, "app.log");
      const rotated = join(dir, "app.log.1");
      await writeFile(file, "old inode\n");
      const helperSource = await readFile(logFileHelperSourcePath, "utf8");
      const proc = Bun.spawn([process.execPath, "--eval", helperSource], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const reader = proc.stdout.getReader();
      const state = { buffer: "" };
      proc.stdin.write(`${JSON.stringify({ op: "open", path: file })}\n`);
      const openResponse = await readProcessLine(reader, state);
      await rename(file, rotated);
      await writeFile(file, "new inode\n");
      proc.stdin.write(`${JSON.stringify({ op: "fstat" })}\n`);
      proc.stdin.write(`${JSON.stringify({ op: "read", offset: "0", maxBytes: 32 })}\n`);
      proc.stdin.write(`${JSON.stringify({ op: "close" })}\n`);
      proc.stdin.end();
      const fstatResponse = await readProcessLine(reader, state);
      const readResponse = await readProcessLine(reader, state);
      await readProcessLine(reader, state);
      const openedStat = objectField(openResponse, "stat");
      const currentPathStat = await Bun.file(file).stat();
      const readBytes = objectField(readResponse, "bytes");

      expect(objectField(openedStat, "ino")).not.toBe(String(currentPathStat.ino));
      expect(objectField(objectField(fstatResponse, "stat"), "ino")).toBe(objectField(openedStat, "ino"));
      expect(Buffer.from(typeof readBytes === "string" ? readBytes : "", "base64").toString("utf8")).toBe(
        "old inode\n",
      );
      expect(await proc.exited).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports copytruncate shrink on the opened handle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-log-helper-"));
    try {
      const file = join(dir, "app.log");
      await writeFile(file, "before truncate\n");
      const helperSource = await readFile(logFileHelperSourcePath, "utf8");
      const proc = Bun.spawn([process.execPath, "--eval", helperSource], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const reader = proc.stdout.getReader();
      const state = { buffer: "" };
      proc.stdin.write(`${JSON.stringify({ op: "open", path: file })}\n`);
      await readProcessLine(reader, state);
      await writeFile(file, "");
      proc.stdin.write(`${JSON.stringify({ op: "fstat" })}\n`);
      proc.stdin.write(`${JSON.stringify({ op: "read", offset: "0", maxBytes: 32 })}\n`);
      proc.stdin.write(`${JSON.stringify({ op: "close" })}\n`);
      proc.stdin.end();
      const fstatResponse = await readProcessLine(reader, state);
      const readResponse = await readProcessLine(reader, state);

      expect(objectField(objectField(fstatResponse, "stat"), "size")).toBe("0");
      expect(objectField(readResponse, "eof")).toBe(true);
      expect(objectField(readResponse, "bytes")).toBe("");
      expect(await proc.exited).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects offsets outside the safe positional-read range", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-log-helper-"));
    try {
      const file = join(dir, "app.log");
      await writeFile(file, "content");
      const lines = await helperLines([
        { op: "open", path: file },
        { op: "read", offset: String(BigInt(Number.MAX_SAFE_INTEGER) + 1n), maxBytes: 1 },
        { op: "close" },
      ]);

      expect(objectField(lines[1], "ok")).toBe(false);
      expect(objectField(lines[1], "code")).toBe("ERANGE");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects malformed read offset and maxBytes fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-log-helper-"));
    try {
      const file = join(dir, "app.log");
      await writeFile(file, "content");
      const lines = await helperLines([
        { op: "open", path: file },
        { op: "read", offset: "01", maxBytes: 1 },
        { op: "read", offset: "0", maxBytes: 1.5 },
        { op: "close" },
      ]);

      expect(objectField(lines[1], "ok")).toBe(false);
      expect(objectField(lines[1], "code")).toBe("EPROTO");
      expect(objectField(lines[2], "ok")).toBe(false);
      expect(objectField(lines[2], "code")).toBe("EPROTO");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cleanup only removes narrowly scoped helper directories", async () => {
    const allowed = join(tmpdir(), "lando-log-file-helper-0123456789abcdef0123456789abcdef");
    const denied = await mkdtemp(join(tmpdir(), "lando-log-helper-"));
    try {
      await mkdir(allowed, { recursive: true });
      await writeFile(join(allowed, "lando-log-file-helper"), "helper");
      await writeFile(join(denied, "keep"), "content");
      const deniedLine = await helperCleanupLine(denied);
      const allowedLine = await helperCleanupLine(allowed);

      expect(objectField(deniedLine, "ok")).toBe(false);
      expect(objectField(deniedLine, "code")).toBe("EPROTO");
      expect(objectField(allowedLine, "ok")).toBe(true);
      expect(await Bun.file(join(denied, "keep")).exists()).toBe(true);
      expect(await pathExists(allowed)).toBe(false);
    } finally {
      await rm(allowed, { recursive: true, force: true });
      await rm(denied, { recursive: true, force: true });
    }
  });
});
