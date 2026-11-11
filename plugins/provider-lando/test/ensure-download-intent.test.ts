import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDownloader } from "@lando/engine/testing/downloader";
import { OnlineAcquisition } from "@lando/sdk/services";
import { Cause, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import nftVersions from "../nft-versions.json";
import { ensureRuntime } from "../src/ensure-runtime.ts";
import { makePluginArtifactDownload } from "../src/plugin-runtime.ts";

test.each([
  ["start", false, 1],
  ["setup", true, 3],
] as const)(
  "provider ensure invoked during %s uses %s acquisition intent and %s attempts",
  async (_command, enabled, attempts) => {
    const root = await mkdtemp(join(tmpdir(), "lando-ensure-intent-"));
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const td = yield* makeTestDownloader();
          for (const entry of Object.values(nftVersions.packages)) {
            for (const artifact of entry) td.failResets(artifact.url, 10);
          }
          const effect = ensureRuntime({
            platform: "linux",
            arch: "x64",
            privateRuntimeDir: join(root, "private"),
            podmanBin: join(root, "bin/podman"),
            storageDir: join(root, "storage"),
            runRoot: join(root, "run"),
            configDir: join(root, "config"),
            socketPath: join(root, "podman.sock"),
            pidPath: join(root, "podman.pid"),
            podmanApi: {
              info: Effect.die("helpers must fail before probing"),
              ping: Effect.die("helpers must fail before probing"),
            },
            serviceRunner: {
              launch: () => Effect.die("must not launch"),
              isAlive: () => Effect.succeed(false),
              isServiceProcess: () => Effect.succeed(false),
              terminate: () => Effect.void,
            },
            nftProvision: {
              download: makePluginArtifactDownload(td.service),
              cacheDir: join(root, "downloads"),
              arch: "x64",
            },
          }).pipe(Effect.provideService(OnlineAcquisition, enabled));
          const fiber = yield* Effect.forkChild(effect);
          if (enabled) {
            yield* td.nextRetry;
            yield* TestClock.adjust("1 second");
            yield* td.nextRetry;
            yield* TestClock.adjust("2 seconds");
          }
          const exit = yield* Fiber.await(fiber);
          expect(td.streamCallCount()).toBe(attempts);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(Cause.squash(exit.cause)).toMatchObject({
              _tag: "ProviderUnavailableError",
              cause: { _tag: "DownloadFetchError", reason: "connection-reset", attempts },
            });
        }).pipe(Effect.provide(TestClock.layer())),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
