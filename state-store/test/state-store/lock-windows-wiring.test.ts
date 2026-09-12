import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { makePrivateFileAccessLive } from "../../src/private-file-access.ts";
import { StateStoreWithPrivateFileAccessLive } from "../../src/service.ts";
import { makeRecordingWorkerSpawn } from "../private-file-worker.ts";

test("the default state layer uses its runner for Windows advisory-lock ACLs", async () => {
  // Given the Windows ACL implementation and a recording runner on any host
  const root = await mkdtemp(join(tmpdir(), "lando-state-windows-wiring-"));
  const worker = makeRecordingWorkerSpawn();
  const privateFileAccess = makePrivateFileAccessLive({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    spawn: worker.spawn,
  });
  try {
    // When a provider-shaped advisory bucket persists a plan through the default layer
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* StateStore;
        const bucket = yield* store.open({
          root: { path: AbsolutePath.make(root) },
          key: "applied-plans.json",
          schema: Schema.Record({ key: Schema.String, value: Schema.String }),
          version: 1,
          mode: 0o600,
          lock: "advisory",
        });
        yield* bucket.modify(() => [undefined, { app: "plan" }]);
      }).pipe(Effect.provide(StateStoreWithPrivateFileAccessLive.pipe(Layer.provide(privateFileAccess)))),
    );
    // Then lock creation, private data publication, and lock release all run the ACL scripts
    expect(worker.requests.map(({ operation }) => operation)).toEqual(["enforce", "enforce", "verify"]);
    expect(worker.spawnCount()).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
