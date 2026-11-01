import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { SHARD_RUNTIME_FLAGS } from "../../../scripts/test-shards.ts";
import { refreshTestTimings } from "../../../scripts/update-test-timings.ts";

const firstFile = "core/test/first.test.ts";
const secondFile = "sdk/test/second.test.ts";
const files = [firstFile, secondFile];
const validCandidate = JSON.stringify({ version: 1, files: { [firstFile]: 0, [secondFile]: 12 } });
const timingPath = (cmd: ReadonlyArray<string>): string => {
  const flag = cmd.find((arg) => arg.startsWith("--timings="));
  if (flag === undefined) throw new Error("missing timing candidate path");
  return flag.slice("--timings=".length);
};

const withTempRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(resolve(tmpdir(), "lando-test-timings-"));
  try {
    await writeFile(resolve(root, ".bun-test-timings.json"), "stale baseline");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("promotes a complete fresh timing candidate after the test command succeeds", async () => {
  await withTempRoot(async (root) => {
    const exitCode = await refreshTestTimings({
      files,
      repoRoot: root,
      runTests: async (cmd, cwd) => {
        expect(cwd).toBe(root);
        expect(cmd.slice(0, 3)).toEqual([process.execPath, "--no-orphans", "test"]);
        expect(cmd.slice(3, 3 + SHARD_RUNTIME_FLAGS.length)).toEqual([...SHARD_RUNTIME_FLAGS]);
        expect(cmd.slice(-3)).toEqual(["--update-timings", ...files.map((path) => `./${path}`)]);
        const candidate = timingPath(cmd);
        expect(candidate).toStartWith(resolve(root, ".bun-test-timings-"));
        await writeFile(candidate, validCandidate);
        return 0;
      },
    });
    expect(exitCode).toBe(0);
    expect(await readFile(resolve(root, ".bun-test-timings.json"), "utf8")).toBe(validCandidate);
    expect(await readdir(root)).toEqual([".bun-test-timings.json"]);
  });
});

test("a failed test command cannot promote a plausible partial candidate", async () => {
  await withTempRoot(async (root) => {
    const exitCode = await refreshTestTimings({
      files,
      repoRoot: root,
      runTests: async (cmd) => {
        await writeFile(timingPath(cmd), validCandidate);
        return 7;
      },
    });
    expect(exitCode).toBe(7);
    expect(await readFile(resolve(root, ".bun-test-timings.json"), "utf8")).toBe("stale baseline");
    expect(await readdir(root)).toEqual([".bun-test-timings.json"]);
  });
});

for (const [name, contents] of [
  ["missing", undefined],
  ["empty", ""],
  ["malformed", "{"],
  ["wrong version", JSON.stringify({ version: 2, files: { [firstFile]: 1, [secondFile]: 2 } })],
  ["empty files", JSON.stringify({ version: 1, files: {} })],
  ["partial coverage", JSON.stringify({ version: 1, files: { [firstFile]: 1 } })],
  ["unexpected path", JSON.stringify({ version: 1, files: { [firstFile]: 1, third: 2 } })],
  ["invalid duration", JSON.stringify({ version: 1, files: { [firstFile]: -1, [secondFile]: 2 } })],
] as const) {
  test(`rejects ${name} output without touching the baseline`, async () => {
    await withTempRoot(async (root) => {
      await expect(
        refreshTestTimings({
          files,
          repoRoot: root,
          runTests: async (cmd) => {
            if (contents !== undefined) {
              await writeFile(timingPath(cmd), contents);
            }
            return 0;
          },
        }),
      ).rejects.toThrow();
      expect(await readFile(resolve(root, ".bun-test-timings.json"), "utf8")).toBe("stale baseline");
      expect(await readdir(root)).toEqual([".bun-test-timings.json"]);
    });
  });
}

test("an empty collection never starts a test command", async () => {
  await withTempRoot(async (root) => {
    await expect(refreshTestTimings({ files: [], repoRoot: root, runTests: async () => 0 })).rejects.toThrow(
      "zero test files",
    );
    expect(await readdir(root)).toEqual([".bun-test-timings.json"]);
  });
});
