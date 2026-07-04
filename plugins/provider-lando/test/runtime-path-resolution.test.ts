import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { type PodmanApiClient, type PodmanServiceRunner, makeRuntimeProvider } from "@lando/provider-lando";
import { AppId, ServiceName } from "@lando/sdk/schema";

const fakeServiceRunner: PodmanServiceRunner = {
  launch: () => Effect.succeed(4242),
  isAlive: () => Effect.succeed(false),
  isServiceProcess: () => Effect.succeed(false),
  terminate: () => Effect.void,
};

describe("provider-lando runtime path resolution", () => {
  test("uses providerSocketPath as the default socket when LANDO_TEST_PODMAN_SOCKET is unset", async () => {
    const previousSocket = process.env.LANDO_TEST_PODMAN_SOCKET;
    Reflect.deleteProperty(process.env, "LANDO_TEST_PODMAN_SOCKET");
    const tempDir = await mkdtemp(join(tmpdir(), "lando-runtime-paths-"));
    const observedSockets: string[] = [];
    try {
      const providerSocketPath = join(tempDir, "runtime", "run", "podman.sock");
      const providerPidPath = join(tempDir, "runtime", "run", "podman.pid");
      const podmanApiFactory = (socketPath: string): PodmanApiClient => {
        observedSockets.push(socketPath);
        return { info: Effect.succeed({}) };
      };
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          platform: "linux",
          podmanApiFactory,
          podmanService: fakeServiceRunner,
          providerSocketPath,
          providerPidPath,
          runtimeBinDir: join(tempDir, "runtime", "bin"),
          runtimeStorageDir: join(tempDir, "runtime", "storage"),
          runtimeRunDir: join(tempDir, "runtime", "run"),
          runtimeConfigDir: join(tempDir, "runtime", "config"),
          rootlessProbes: {
            probe: () => ({
              subidConfigured: true,
              hasUidmapTools: true,
              cgroupsV2Delegated: true,
              hasXdgRuntimeDir: true,
            }),
          },
        }),
      );

      await Effect.runPromiseExit(
        provider.exec(
          { app: AppId.make("path-resolution"), service: ServiceName.make("app") },
          { command: ["true"] },
        ),
      );

      expect(observedSockets).toEqual([providerSocketPath]);
      expect(await readFile(providerPidPath, "utf8")).toBe("4242");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      if (previousSocket === undefined) Reflect.deleteProperty(process.env, "LANDO_TEST_PODMAN_SOCKET");
      else process.env.LANDO_TEST_PODMAN_SOCKET = previousSocket;
    }
  });

  test("ignores LANDO_TEST_PODMAN_SOCKET in production and uses the injected managed socket", async () => {
    const previousSocket = process.env.LANDO_TEST_PODMAN_SOCKET;
    process.env.LANDO_TEST_PODMAN_SOCKET = "/tmp/should-never-be-used.sock";
    const tempDir = await mkdtemp(join(tmpdir(), "lando-runtime-paths-env-"));
    const observedSockets: string[] = [];
    try {
      const providerSocketPath = join(tempDir, "runtime", "run", "podman.sock");
      const providerPidPath = join(tempDir, "runtime", "run", "podman.pid");
      const podmanApiFactory = (socketPath: string): PodmanApiClient => {
        observedSockets.push(socketPath);
        return { info: Effect.succeed({}) };
      };
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          platform: "linux",
          podmanApiFactory,
          podmanService: fakeServiceRunner,
          providerSocketPath,
          providerPidPath,
          runtimeBinDir: join(tempDir, "runtime", "bin"),
          runtimeStorageDir: join(tempDir, "runtime", "storage"),
          runtimeRunDir: join(tempDir, "runtime", "run"),
          runtimeConfigDir: join(tempDir, "runtime", "config"),
          rootlessProbes: {
            probe: () => ({
              subidConfigured: true,
              hasUidmapTools: true,
              cgroupsV2Delegated: true,
              hasXdgRuntimeDir: true,
            }),
          },
        }),
      );

      await Effect.runPromiseExit(
        provider.exec(
          { app: AppId.make("path-resolution-env"), service: ServiceName.make("app") },
          { command: ["true"] },
        ),
      );

      expect(observedSockets).toEqual([providerSocketPath]);
      expect(observedSockets).not.toContain("/tmp/should-never-be-used.sock");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      if (previousSocket === undefined) Reflect.deleteProperty(process.env, "LANDO_TEST_PODMAN_SOCKET");
      else process.env.LANDO_TEST_PODMAN_SOCKET = previousSocket;
    }
  });
});
