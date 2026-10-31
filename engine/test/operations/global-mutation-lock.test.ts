import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { GlobalAppError, StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath, ProviderId } from "@lando/sdk/schema";
import { GlobalAppService, PathsService } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { withGlobalMutation } from "../../src/global-app/mutation.ts";
import { appMutationLockKey } from "../../src/operations/app-mutation-lock.ts";

const fixture = async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "lando-global-mutation-")));
  const root = join(directory, "embedded-global");
  await mkdir(root);
  const paths = makeLandoPaths({ userDataRoot: join(directory, "data") });
  const service = (appRoot: string) =>
    GlobalAppService.of({
      id: "global",
      root: Effect.succeed(AbsolutePath.make(appRoot)),
      paths: Effect.succeed({
        root: AbsolutePath.make(appRoot),
        distLandofile: AbsolutePath.make(join(appRoot, ".lando.dist.yml")),
        userLandofile: AbsolutePath.make(join(appRoot, ".lando.yml")),
      }),
      providerId: Effect.succeed(ProviderId.make("docker")),
      ensureRoot: Effect.void,
      ensureUserLandofile: Effect.die("No global materialization in lock tests."),
      ensureRunning: () => Effect.die("No provider startup in lock tests."),
      regenerateDist: () => Effect.die("No generation in lock tests."),
    });
  const layer = Layer.mergeAll(
    PrivateFileAccessService.layer,
    Layer.succeed(PathsService, paths),
    Layer.succeed(GlobalAppService, service(root)),
  );
  const lockPath = (appRoot: string) =>
    join(paths.roots.userDataRoot, "operation-locks", `${appMutationLockKey("global", appRoot)}.lock`);
  return { directory, root, paths, service, layer, lockPath };
};

test("global mutations lock the actual embedded root and nested calls reuse that lock", async () => {
  const isolated = await fixture();
  try {
    const tokens = await Effect.runPromise(
      withGlobalMutation(
        Effect.gen(function* () {
          const first = yield* Effect.promise(() => Bun.file(isolated.lockPath(isolated.root)).json());
          const nested = yield* withGlobalMutation(
            Effect.promise(() => Bun.file(isolated.lockPath(isolated.root)).json()),
          );
          return { first, nested };
        }),
      ).pipe(Effect.provide(isolated.layer)),
    );
    expect(tokens.first.pid).toBe(process.pid);
    expect(tokens.nested.token).toBe(tokens.first.token);
    expect(await Bun.file(isolated.lockPath(isolated.root)).exists()).toBe(false);
    expect(await Bun.file(isolated.lockPath(isolated.paths.globalAppRoot)).exists()).toBe(false);
  } finally {
    await rm(isolated.directory, { recursive: true, force: true });
  }
});

test("nested embedded globals with different roots acquire distinct locks", async () => {
  const isolated = await fixture();
  const secondRoot = join(isolated.directory, "second-global");
  await mkdir(secondRoot);
  try {
    const result = await Effect.runPromise(
      withGlobalMutation(
        Effect.gen(function* () {
          const first = yield* Effect.promise(() => Bun.file(isolated.lockPath(isolated.root)).json());
          const second = yield* withGlobalMutation(
            Effect.promise(() => Bun.file(isolated.lockPath(secondRoot)).json()),
          ).pipe(Effect.provideService(GlobalAppService, isolated.service(secondRoot)));
          return { first, second };
        }),
      ).pipe(Effect.provide(isolated.layer)),
    );
    expect(result.second.pid).toBe(process.pid);
    expect(result.second.token).not.toBe(result.first.token);
    expect(await Bun.file(isolated.lockPath(secondRoot)).exists()).toBe(false);
  } finally {
    await rm(isolated.directory, { recursive: true, force: true });
  }
});

test("cancellation releases the global lock before a later command acquires it", async () => {
  const isolated = await fixture();
  const acquired = Deferred.makeUnsafe<void>();
  try {
    const fiber = Effect.runFork(
      withGlobalMutation(Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Effect.never))).pipe(
        Effect.provide(isolated.layer),
      ),
    );
    await Effect.runPromise(Deferred.await(acquired));
    expect(await Bun.file(isolated.lockPath(isolated.root)).exists()).toBe(true);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(await Bun.file(isolated.lockPath(isolated.root)).exists()).toBe(false);
    expect(
      await Effect.runPromise(
        withGlobalMutation(Effect.succeed("entered")).pipe(Effect.provide(isolated.layer)),
      ),
    ).toBe("entered");
  } finally {
    await rm(isolated.directory, { recursive: true, force: true });
  }
});

test("body failures retain their identity instead of becoming coordination failures", async () => {
  const isolated = await fixture();
  const failure = new StateStoreError({
    reason: "io",
    operation: "read-policy",
    path: "/policy",
    remediation: "Repair policy permissions.",
  });
  try {
    const result = await Effect.runPromise(
      Effect.result(withGlobalMutation(Effect.fail(failure))).pipe(Effect.provide(isolated.layer)),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure).toBe(failure);
  } finally {
    await rm(isolated.directory, { recursive: true, force: true });
  }
});

test("coordination failures retain lock remediation rather than blaming policy booleans", async () => {
  const isolated = await fixture();
  try {
    const result = await Effect.runPromise(
      Effect.result(withGlobalMutation(Effect.void)).pipe(
        Effect.provideService(PrivateFileAccessService, {
          enforce: async () => {
            throw new Error("private lock access denied");
          },
          verify: async () => undefined,
        }),
        Effect.provide(isolated.layer),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(GlobalAppError);
      expect(result.failure.operation).toBe("coordination");
      expect(result.failure.remediation).not.toContain("boolean");
    }
  } finally {
    await rm(isolated.directory, { recursive: true, force: true });
  }
});
