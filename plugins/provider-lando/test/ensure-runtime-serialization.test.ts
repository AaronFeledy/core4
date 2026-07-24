import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Duration, Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";

import type { PodmanApiClient } from "../src/capabilities.ts";
import { ensureRuntime } from "../src/ensure-runtime.ts";
import type { PodmanServiceRunner } from "../src/podman-service-runner.ts";

const unavailable = () =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "podman-api",
    message: "unreachable",
    remediation: "test remediation",
  });

describe("ensureRuntime launch serialization", () => {
  test("a second ensure waits for the first launch to become ready before inspecting it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-cold-launch-"));
    try {
      let launches = 0;
      let postLaunchPings = 0;
      let alive = false;
      let terminations = 0;
      let activeLocks = 0;
      const readinessLockStates: boolean[] = [];
      const lock = Effect.unsafeMakeSemaphore(1);
      const withLaunchLock = <A, E>(body: Effect.Effect<A, E>) =>
        lock.withPermits(1)(
          Effect.acquireUseRelease(
            Effect.sync(() => {
              activeLocks += 1;
            }),
            () => body,
            () =>
              Effect.sync(() => {
                activeLocks -= 1;
              }),
          ),
        );
      const podmanApi: PodmanApiClient = {
        info: Effect.succeed({}),
        ping: Effect.suspend(() => {
          if (!alive) return Effect.fail(unavailable());
          readinessLockStates.push(activeLocks > 0);
          postLaunchPings += 1;
          return postLaunchPings >= 2 ? Effect.void : Effect.fail(unavailable());
        }),
      };
      const serviceRunner: PodmanServiceRunner = {
        launch: () =>
          Effect.gen(function* () {
            yield* Effect.yieldNow();
            launches += 1;
            alive = true;
            return 9100 + launches;
          }),
        isAlive: () => Effect.succeed(alive),
        isServiceProcess: () => Effect.succeed(alive),
        terminate: () =>
          Effect.sync(() => {
            terminations += 1;
            alive = false;
          }),
      };
      const deps = {
        platform: "linux" as const,
        podmanApi,
        serviceRunner,
        podmanBin: join(dir, "bin", "podman"),
        storageDir: join(dir, "storage"),
        runRoot: join(dir, "run"),
        configDir: join(dir, "config"),
        socketPath: join(dir, "run", "podman.sock"),
        pidPath: join(dir, "run", "podman.pid"),
        readinessPolicy: {
          maxAttempts: 3,
          delay: Duration.millis(1),
          timeout: Duration.millis(50),
        },
        withLaunchLock,
      };

      await Effect.runPromise(Effect.all([ensureRuntime(deps), ensureRuntime(deps)], { concurrency: 2 }));

      expect(launches).toBe(1);
      expect(terminations).toBe(0);
      expect(readinessLockStates.every(Boolean)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("two racing ensures share the cross-process lock and launch once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-serialization-"));
    try {
      let launched = false;
      let launches = 0;
      let activeLocks = 0;
      let maximumActiveLocks = 0;
      const lock = Effect.unsafeMakeSemaphore(1);
      const withLaunchLock = <A, E>(body: Effect.Effect<A, E>) =>
        lock.withPermits(1)(
          Effect.acquireUseRelease(
            Effect.sync(() => {
              activeLocks += 1;
              maximumActiveLocks = Math.max(maximumActiveLocks, activeLocks);
            }),
            () => body,
            () =>
              Effect.sync(() => {
                activeLocks -= 1;
              }),
          ),
        );
      const podmanApi: PodmanApiClient = {
        info: Effect.succeed({}),
        ping: Effect.suspend(() => (launched ? Effect.void : Effect.fail(unavailable()))),
      };
      const serviceRunner: PodmanServiceRunner = {
        launch: () =>
          Effect.sync(() => {
            launches += 1;
            launched = true;
            return 9000 + launches;
          }),
        isAlive: () => Effect.succeed(launched),
        isServiceProcess: () => Effect.succeed(launched),
        terminate: () => Effect.void,
      };
      const deps = {
        platform: "linux" as const,
        podmanApi,
        serviceRunner,
        podmanBin: join(dir, "bin", "podman"),
        storageDir: join(dir, "storage"),
        runRoot: join(dir, "run"),
        configDir: join(dir, "config"),
        socketPath: join(dir, "run", "podman.sock"),
        pidPath: join(dir, "run", "podman.pid"),
        withLaunchLock,
      };

      await Effect.runPromise(Effect.all([ensureRuntime(deps), ensureRuntime(deps)], { concurrency: 2 }));

      expect(launches).toBe(1);
      expect(maximumActiveLocks).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  for (const platform of ["darwin", "win32"] as const) {
    test(`${platform} machine ensures use the launch lock`, async () => {
      const lock = Effect.unsafeMakeSemaphore(1);
      let active = 0;
      let maximumActive = 0;
      const machineRunner = {
        inspect: Effect.acquireUseRelease(
          Effect.sync(() => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
          }),
          () => Effect.yieldNow().pipe(Effect.as("running" as const)),
          () =>
            Effect.sync(() => {
              active -= 1;
            }),
        ),
        create: Effect.void,
        start: Effect.void,
        stop: Effect.void,
        upgrade: Effect.void,
        teardown: Effect.void,
      };
      const deps = {
        platform,
        podmanApi: { info: Effect.succeed({}), ping: Effect.void },
        serviceRunner: {
          launch: () => Effect.die("machine ensure must not launch a host service"),
          isAlive: () => Effect.succeed(false),
          terminate: () => Effect.void,
        },
        machineRunner,
        podmanBin: "/runtime/bin/podman",
        storageDir: "/runtime/storage",
        runRoot: "/runtime/run",
        configDir: "/runtime/config",
        socketPath: "/runtime/run/podman.sock",
        pidPath: "/runtime/run/podman.pid",
        withLaunchLock: <A, E>(body: Effect.Effect<A, E>) => lock.withPermits(1)(body),
      };

      await Effect.runPromise(Effect.all([ensureRuntime(deps), ensureRuntime(deps)], { concurrency: 2 }));

      expect(maximumActive).toBe(1);
    });
  }
});
