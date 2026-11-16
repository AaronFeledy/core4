import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { PathsService, StateStore } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { PrivateFileAccessService } from "../../src/private-file-access.ts";
import * as StateStoreLayer from "../../src/service.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

test.skipIf(process.platform === "win32")(
  "the state store never takes a live owner's lock and still recovers a dead owner's",
  async () => {
    // Given a real state store over isolated roots and a lock held by a live process 31 s ago
    const root = await realpath(await mkdtemp(join(tmpdir(), "lando-live-owner-lock-")));
    const paths = makeLandoPaths({
      userDataRoot: join(root, "data"),
      userCacheRoot: join(root, "cache"),
      userConfRoot: join(root, "config"),
      systemPluginRoot: join(root, "system-plugins"),
    });
    const lockDir = join(root, "data", "operation-locks");
    const liveLock = join(lockDir, "live-owner.lock");
    const deadLock = join(lockDir, "dead-owner.lock");
    const owner = Bun.spawn(["sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const store = await Effect.runPromise(
      StateStore.pipe(
        Effect.provide(
          StateStoreLayer.layerWithPrivateFileAccess.pipe(
            Layer.provide(
              Layer.succeed(PrivateFileAccessService, PrivateFileAccessService.of(ownerOnlyFileAccess)),
            ),
            Layer.provide(Layer.succeed(PathsService, PathsService.of(paths))),
          ),
        ),
      ),
    );
    try {
      await mkdir(lockDir, { recursive: true });
      const liveRecord = JSON.stringify({
        pid: owner.pid,
        token: "live",
        createdAt: Date.now() - 31_000,
      });
      await writeFile(liveLock, liveRecord, { mode: 0o600 });
      let liveBodyRan = false;

      // When a second acquisition meets the live owner's thirty-one-second-old record
      const liveResult = await Effect.runPromise(
        Effect.result(
          store.withLock(
            "live-owner",
            Effect.sync(() => {
              liveBodyRan = true;
              return "stole the lock";
            }),
          ),
        ),
      );

      // Then it waits out the deadline, fails as contention naming the live owner, and keeps the record
      expect(liveBodyRan).toBe(false);
      expect(liveResult._tag).toBe("Failure");
      if (liveResult._tag === "Failure") {
        expect(liveResult.failure).toMatchObject({
          _tag: "StateStoreError",
          reason: "lock",
          path: liveLock,
          cause: { ownerPid: owner.pid },
        });
      }
      expect(await readFile(liveLock, "utf8")).toBe(liveRecord);

      // And a dead owner's fresh record is still recovered, then released
      await writeFile(deadLock, JSON.stringify({ pid: 99_999_999, token: "dead", createdAt: Date.now() }), {
        mode: 0o600,
      });
      const recovered = await Effect.runPromise(store.withLock("dead-owner", Effect.succeed("recovered")));
      expect(recovered).toBe("recovered");
      await expect(stat(deadLock)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      owner.kill();
      await owner.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
);
