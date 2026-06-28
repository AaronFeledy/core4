import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { makeLandoPaths } from "../../src/config/paths.ts";

const registrySource = readFileSync(join(import.meta.dir, "../../src/providers/registry.ts"), "utf8");

describe("lando runtime registry wiring", () => {
  test("makeLandoPaths exposes all private runtime paths under userDataRoot/runtime", () => {
    const paths = makeLandoPaths({ platform: "linux", home: "/home/tester", userDataRoot: "/data" });
    expect(paths.runtimeBinDir).toBe("/data/runtime/bin");
    expect(paths.runtimeRunDir).toBe("/data/runtime/run");
    expect(paths.runtimeStorageDir).toBe("/data/runtime/storage");
    expect(paths.runtimeConfigDir).toBe("/data/runtime/config");
    expect(paths.providerSocketPath).toBe("/data/runtime/run/podman.sock");
    expect(paths.providerPidPath).toBe("/data/runtime/run/podman.pid");
  });

  test("registry passes every private runtime path from makeLandoPaths into makeLandoRuntimeProvider", () => {
    const requiredWiring = [
      "runtimeBinDir: landoPaths.runtimeBinDir",
      "runtimeRunDir: landoPaths.runtimeRunDir",
      "runtimeStorageDir: landoPaths.runtimeStorageDir",
      "runtimeConfigDir: landoPaths.runtimeConfigDir",
      "providerSocketPath: landoPaths.providerSocketPath",
      "providerPidPath: landoPaths.providerPidPath",
    ] as const;

    for (const fragment of requiredWiring) {
      expect(registrySource).toContain(fragment);
    }
  });
});
