import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { writeManagedRuntimeContainersConf } from "../src/runtime-config.ts";

describe("writeManagedRuntimeContainersConf", () => {
  test("writes helper_binaries_dir pointing at runtimeBinDir", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-runtime-config-"));
    const runtimeBinDir = join(root, "runtime", "bin");
    const runtimeConfigDir = join(root, "runtime", "config");
    try {
      await Effect.runPromise(writeManagedRuntimeContainersConf({ runtimeBinDir, runtimeConfigDir }));
      const body = await readFile(join(runtimeConfigDir, "containers.conf"), "utf8");
      expect(body).toContain(`helper_binaries_dir = ["${runtimeBinDir}"]`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
