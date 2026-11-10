import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Semaphore } from "effect";

import { Duration, Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { makeStateStore } from "@lando/state-store/service";
import { makeRuntimeShutdownStore, openRuntimeShutdown } from "../src/runtime-shutdown.ts";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
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
  test.each([false, true])(
    "Linux admission precedes spawn and blocks spawn on receipt failure=%s",
    async (fail) => {
      const dir = await mkdtemp(join(tmpdir(), "lando-admission-"));
      try {
        const stateStore = makePluginStateStore(
          makeStateStore({ privateFileAccess: ownerOnlyFileAccess }),
          AbsolutePath.make(join(dir, "state")),
          ownerOnlyFileAccess,
        );
        const receipt = await Effect.runPromise(
          makeRuntimeShutdownStore(stateStore, () => Effect.succeed("boot")),
        );
        const bucket = await Effect.runPromise(openRuntimeShutdown(stateStore));
        if (fail) await mkdir(bucket.path, { recursive: true });
        let spawned = false;
        let admittedAtSpawn: unknown;
        let held = false;
        const result = await Effect.runPromise(
          Effect.result(
            ensureRuntime({
              platform: "linux",
              podmanBin: join(dir, "bin", "podman"),
              storageDir: join(dir, "storage"),
              runRoot: join(dir, "run"),
              configDir: join(dir, "config"),
              socketPath: join(dir, "run", "podman.sock"),
              pidPath: join(dir, "run", "podman.pid"),
              podmanApi: {
                info: Effect.succeed({}),
                ping: Effect.suspend(() => (spawned ? Effect.void : Effect.fail(unavailable()))),
              },
              serviceRunner: {
                launch: () =>
                  receipt.read.pipe(
                    Effect.orDie,
                    Effect.map((proof) => {
                      admittedAtSpawn = { proof, held };
                      spawned = true;
                      return 9100;
                    }),
                  ),
                isAlive: () => Effect.succeed(false),
                terminate: () => Effect.void,
              },
              admit: receipt.admit,
              withLaunchLock: (body) =>
                Effect.acquireUseRelease(
                  Effect.sync(() => {
                    held = true;
                  }),
                  () => body,
                  () =>
                    Effect.sync(() => {
                      held = false;
                    }),
                ),
            }),
          ),
        );
        if (fail) {
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "ProviderUnavailableError", operation: "runtimeShutdown" },
          });
          expect(spawned).toBe(false);
        } else {
          expect(result._tag).toBe("Success");
          expect(admittedAtSpawn).toMatchObject({ proof: { state: "admitted", bootId: "boot" }, held: true });
          expect((await stat(bucket.path)).mode & 0o777).toBe(0o600);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test("a concurrent admission supersedes shutdown and repeated quiesce writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-receipt-generation-"));
    try {
      const stateStore = makePluginStateStore(
        makeStateStore({ privateFileAccess: ownerOnlyFileAccess }),
        AbsolutePath.make(dir),
        ownerOnlyFileAccess,
      );
      const receipt = await Effect.runPromise(
        makeRuntimeShutdownStore(stateStore, () => Effect.succeed("boot")),
      );
      const bucket = await Effect.runPromise(openRuntimeShutdown(stateStore));
      await Effect.runPromise(receipt.admit);
      const first = await Effect.runPromise(receipt.read);
      if (first === null) throw new Error("Admission must persist a receipt");
      await Effect.runPromise(receipt.admit);
      const second = await Effect.runPromise(receipt.read);
      if (second === null) throw new Error("Admission must persist a receipt");
      expect(second.generation).not.toBe(first.generation);
      const admittedStat = await stat(bucket.path);
      await Effect.runPromise(receipt.quiesce(first.generation));
      expect(await Effect.runPromise(receipt.read)).toEqual(second);
      expect((await stat(bucket.path)).ino).toBe(admittedStat.ino);
      await Effect.runPromise(receipt.quiesce(second.generation));
      expect(await Effect.runPromise(receipt.read)).toEqual({ ...second, state: "stopped" });
      const stoppedStat = await stat(bucket.path);
      await Effect.runPromise(receipt.quiesce(second.generation));
      expect((await stat(bucket.path)).ino).toBe(stoppedStat.ino);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("a second ensure waits for the first launch to become ready before inspecting it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ensure-cold-launch-"));
    try {
      let launches = 0;
      let postLaunchPings = 0;
      let alive = false;
      let terminations = 0;
      let activeLocks = 0;
      const readinessLockStates: boolean[] = [];
      const lock = Semaphore.makeUnsafe(1);
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
        launch: Effect.fnUntraced(function* () {
          yield* Effect.yieldNow;
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
      const lock = Semaphore.makeUnsafe(1);
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
    test(`${platform} healthy machine ensures skip the launch lock`, async () => {
      const lock = Semaphore.makeUnsafe(1);
      let active = 0;
      let maximumActive = 0;
      let lockCalls = 0;
      const machineRunner = {
        inspect: Effect.acquireUseRelease(
          Effect.sync(() => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
          }),
          () => Effect.yieldNow.pipe(Effect.as("running" as const)),
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
        withLaunchLock: <A, E>(body: Effect.Effect<A, E>) => {
          lockCalls += 1;
          return lock.withPermits(1)(body);
        },
      };

      await Effect.runPromise(Effect.all([ensureRuntime(deps), ensureRuntime(deps)], { concurrency: 2 }));

      expect(lockCalls).toBe(0);
      expect(maximumActive).toBe(2);
    });
  }
});
