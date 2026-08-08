import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { makeLandoPaths } from "@lando/paths";

const registrySource = readFileSync(
  join(import.meta.dir, "../../../engine/src/providers/registry.ts"),
  "utf8",
);
const providerSource = readFileSync(
  join(import.meta.dir, "../../../plugins/provider-lando/src/index.ts"),
  "utf8",
);

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

  test("provider descriptor resolves private runtime paths from PathsService", () => {
    expect(providerSource).toContain("const paths = yield* PathsService");
    expect(registrySource).not.toContain("runtimeBinDir:");

    const requiredWiring = [
      "runtimeBinDir: paths.runtimeBinDir",
      "runtimeRunDir: paths.runtimeRunDir",
      "runtimeStorageDir: paths.runtimeStorageDir",
      "runtimeConfigDir: paths.runtimeConfigDir",
      "providerSocketPath: paths.providerSocketPath",
      "providerPidPath: paths.providerPidPath",
    ] as const;

    for (const fragment of requiredWiring) {
      expect(providerSource).toContain(fragment);
    }
  });
});
