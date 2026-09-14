import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePerformanceStores } from "../../../scripts/workflow-performance-stores.ts";

test.each([0, 1])("keeps helper cleanup before releasing executable roots when exit=%s", async (exitCode) => {
  // Given an owned store whose namespace deletion can spawn another pause process.
  const root = await mkdtemp(join(tmpdir(), "perf-helper-"));
  const stores = await acquirePerformanceStores(root, "sample");
  const bin = join(stores.sampleRoot, "data/runtime/bin");
  await mkdir(bin, { recursive: true });
  await mkdir(join(stores.sampleRoot, "data/runtime/storage"));
  const commands: string[] = [];
  try {
    // When storage deletion finishes but its helper cleanup succeeds or fails.
    const failures = await stores.release(
      async (command) => {
        commands.push(command.id);
        expect(existsSync(bin)).toBe(true);
        return {
          id: command.id,
          exitCode: command.id === "cleanup:storage-helpers" ? exitCode : 0,
          durationMs: 0,
          stdout: "",
          stderr: "",
        };
      },
      { id: "cleanup:storage", argv: [], cwd: root, env: {} },
    );
    // Then helper cleanup is mandatory, and failure retains its executable and runtime roots.
    expect(commands).toEqual(["cleanup:storage", "cleanup:storage-helpers"]);
    expect(failures.map((failure) => failure.id)).toEqual(exitCode === 0 ? [] : ["cleanup:storage-helpers"]);
    expect(existsSync(bin)).toBe(exitCode !== 0);
    expect(existsSync(stores.runtimeRoot)).toBe(exitCode !== 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stores.runtimeRoot, { recursive: true, force: true });
  }
});
