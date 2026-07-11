import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";

import { type PodmanApiClient, type PodmanServiceRunner, makeRuntimeProvider } from "@lando/provider-lando";
import { ProviderUnavailableError } from "@lando/sdk/errors";
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
        return { info: Effect.succeed({}), ping: Effect.succeed(undefined) };
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
        return { info: Effect.succeed({}), ping: Effect.succeed(undefined) };
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

  test("darwin managed runtime fails without bundled machine tooling instead of falling back to system Podman", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lando-runtime-paths-darwin-missing-"));
    try {
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          platform: "darwin",
          podmanApiFactory: () => ({ info: Effect.succeed({}), ping: Effect.succeed(undefined) }),
          podmanService: fakeServiceRunner,
          providerSocketPath: join(tempDir, "runtime", "run", "podman.sock"),
          providerPidPath: join(tempDir, "runtime", "run", "podman.pid"),
          runtimeStorageDir: join(tempDir, "runtime", "storage"),
          runtimeRunDir: join(tempDir, "runtime", "run"),
          runtimeConfigDir: join(tempDir, "runtime", "config"),
        }),
      );

      const exit = await Effect.runPromiseExit(
        provider.exec(
          { app: AppId.make("path-resolution-darwin-missing"), service: ServiceName.make("app") },
          { command: ["true"] },
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
          expect(failure.value.message).toContain("Podman machine runner is required");
        }
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("darwin managed runtime resolves machine commands from the bundled Podman path", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lando-runtime-paths-darwin-bundle-"));
    try {
      const runtimeBinDir = join(tempDir, "runtime", "bin");
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          platform: "darwin",
          podmanApiFactory: () => ({ info: Effect.succeed({}), ping: Effect.succeed(undefined) }),
          podmanService: fakeServiceRunner,
          providerSocketPath: join(tempDir, "runtime", "run", "podman.sock"),
          providerPidPath: join(tempDir, "runtime", "run", "podman.pid"),
          runtimeBinDir,
          runtimeStorageDir: join(tempDir, "runtime", "storage"),
          runtimeRunDir: join(tempDir, "runtime", "run"),
          runtimeConfigDir: join(tempDir, "runtime", "config"),
        }),
      );

      const exit = await Effect.runPromiseExit(
        provider.exec(
          { app: AppId.make("path-resolution-darwin-bundle"), service: ServiceName.make("app") },
          { command: ["true"] },
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
          expect(failure.value.message).toContain("Podman machine inspect failed");
          expect(String(failure.value.cause)).toContain(`${runtimeBinDir}/podman`);
        }
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
