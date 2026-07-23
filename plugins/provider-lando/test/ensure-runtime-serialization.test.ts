import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

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
});
