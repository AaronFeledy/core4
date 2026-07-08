import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildManagedRuntimeServiceSpec,
  managedRuntimePodmanArgv0,
} from "@lando/core/managed-runtime-service";
import { makeLandoPaths } from "@lando/core/paths";

import { buildPodmanServiceArgs } from "../src/podman-service-runner.ts";

test("buildPodmanServiceArgs stays byte-identical to the core managed runtime service argv", () => {
  const paths = makeLandoPaths({ userDataRoot: "/tmp/lando-provider-parity" });
  const coreSpec = buildManagedRuntimeServiceSpec({ ...paths, platform: "linux" });
  // argv[0] match key must equal the exact spawned string, never a join-normalized path.
  const podmanBin = managedRuntimePodmanArgv0(paths.runtimeBinDir, "linux");
  const providerSpec = buildPodmanServiceArgs({
    podmanBin,
    storageDir: paths.runtimeStorageDir,
    runRoot: paths.runtimeRunDir,
    configDir: paths.runtimeConfigDir,
    socketPath: paths.providerSocketPath,
  });

  expect(podmanBin).toBe(`${paths.runtimeBinDir}/podman`);
  expect([providerSpec.command, ...providerSpec.args]).toEqual([coreSpec.command, ...coreSpec.args]);
  expect(providerSpec.command).toBe(coreSpec.command);
  expect(providerSpec.args).toEqual(coreSpec.args);
  expect(providerSpec.socketPath).toBe(coreSpec.socketPath);
});

test("the production provider launch uses the shared managed-runtime argv0 helper", () => {
  const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");

  // Source guard: launched bin must come from the shared helper so argv[0] cannot drift.
  expect(source).toContain("managedRuntimePodmanArgv0(runtimeBinDir, platform)");
  expect(source).not.toContain("`${runtimeBinDir}/podman`");
});

test("provider delegates Podman service arg shaping to the core managed runtime helper", () => {
  const source = readFileSync(join(import.meta.dir, "../src/podman-service-runner.ts"), "utf8");

  expect(source).toContain("buildManagedRuntimeServiceArgs");

  const buildFn = source.match(/export const buildPodmanServiceArgs[\s\S]*?^};/m)?.[0];
  expect(buildFn).toBeDefined();
  expect(buildFn).not.toContain('"--root"');
  expect(buildFn).not.toContain('"system"');
});
