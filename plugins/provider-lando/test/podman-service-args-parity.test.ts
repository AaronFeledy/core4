import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildManagedRuntimeServiceSpec } from "@lando/core/managed-runtime-service";
import { makeLandoPaths } from "@lando/core/paths";

import { buildPodmanServiceArgs } from "../src/podman-service-runner.ts";

test("buildPodmanServiceArgs stays byte-identical to the core managed runtime service argv", () => {
  const paths = makeLandoPaths({ userDataRoot: "/tmp/lando-provider-parity" });
  const coreSpec = buildManagedRuntimeServiceSpec(paths);
  const providerSpec = buildPodmanServiceArgs({
    podmanBin: join(paths.runtimeBinDir, "podman"),
    storageDir: paths.runtimeStorageDir,
    runRoot: paths.runtimeRunDir,
    configDir: paths.runtimeConfigDir,
    socketPath: paths.providerSocketPath,
  });

  expect(providerSpec.command).toBe(coreSpec.command);
  expect(providerSpec.args).toEqual(coreSpec.args);
  expect(providerSpec.socketPath).toBe(coreSpec.socketPath);
});

test("provider delegates Podman service arg shaping to the core managed runtime helper", () => {
  const source = readFileSync(join(import.meta.dir, "../src/podman-service-runner.ts"), "utf8");

  expect(source).toContain("buildManagedRuntimeServiceArgs");
  expect(source).not.toContain('"--root"');
});
