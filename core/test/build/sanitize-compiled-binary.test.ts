import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { compiledBinaryPath, sanitizeCompiledBinary } from "../../../scripts/sanitize-compiled-binary.ts";

test("sanitizes the Windows executable when Bun appends .exe", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "lando-sanitize-windows-"));
  const requestedPath = resolve(directory, "lando");
  const executablePath = `${requestedPath}.exe`;
  try {
    await Bun.write(requestedPath, "stale .tsbuildinfo binary");
    await Bun.write(executablePath, "current .tsbuildinfo executable");

    expect(compiledBinaryPath(requestedPath, "win32")).toBe(executablePath);
    expect(compiledBinaryPath(executablePath, "win32")).toBe(executablePath);
    await sanitizeCompiledBinary(requestedPath, "win32");

    expect(await Bun.file(executablePath).text()).toBe("current .tsbuildnoop executable");
    expect(await Bun.file(requestedPath).text()).toBe("stale .tsbuildinfo binary");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sanitizes the requested filename on Unix", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "lando-sanitize-unix-"));
  const requestedPath = resolve(directory, "lando");
  try {
    await Bun.write(requestedPath, "current .tsbuildinfo binary");
    expect(compiledBinaryPath(requestedPath, "linux")).toBe(requestedPath);
    await sanitizeCompiledBinary(requestedPath, "linux");
    expect(await Bun.file(requestedPath).text()).toBe("current .tsbuildnoop binary");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
