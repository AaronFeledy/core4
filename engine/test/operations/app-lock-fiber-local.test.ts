import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath } from "@lando/sdk/schema";
import { PathsService } from "@lando/sdk/services";
import { resolveStatePath } from "@lando/state-store/paths";
import { PrivateFileAccessLive } from "@lando/state-store/private-file-access";
import { Effect, Fiber, Layer } from "effect";
import { appMutationLockIdentity, withAppMutationLock } from "../../src/operations/app-mutation-lock.ts";

test("forked app-lock children reuse the parent's lock, while a later unbound acquire takes a fresh lock", async () => {
  // Given
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-app-lock-fiber-")));
  const app = { id: "fiber-local-app", root };
  const dependencies = Layer.mergeAll(
    PrivateFileAccessLive,
    Layer.succeed(PathsService, makeLandoPaths({ userDataRoot: root })),
  );
  try {
    // When
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const identity = yield* appMutationLockIdentity(app);
        const path = yield* resolveStatePath(
          { path: AbsolutePath.make(root) },
          "operation-locks",
          identity.key,
          "test",
        );
        const readLock = Effect.promise(() => Bun.file(`${path.file}.lock`).text());
        const held = yield* withAppMutationLock(
          app,
          Effect.gen(function* () {
            const parent = yield* readLock;
            const child = yield* Effect.forkChild(withAppMutationLock(app, readLock));
            return { parent, child: yield* Fiber.join(child) };
          }),
        );
        const fresh = yield* withAppMutationLock(app, readLock);
        return { ...held, fresh };
      }).pipe(Effect.provide(dependencies), Effect.timeout("2 seconds")),
    );
    // Then
    expect(result.parent.length).toBeGreaterThan(0);
    expect(result.child).toBe(result.parent);
    expect(result.fresh.length).toBeGreaterThan(0);
    expect(result.fresh).not.toBe(result.parent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
