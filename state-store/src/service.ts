import { rename, stat } from "node:fs/promises";

import { Effect, Layer, Option } from "effect";

import { StateStoreError, isErrnoCode } from "@lando/sdk/errors";
import {
  type LandoRoots,
  PathsService,
  type StateBucket,
  type StateBucketSpec,
  StateStore,
  type StateStoreShape,
} from "@lando/sdk/services";

import { writeFileAtomicScoped } from "./atomic.ts";
import { type StateBucketBackend, buildStateBucket } from "./bucket.ts";
import { withAdvisoryLockUsing } from "./lock.ts";
import { resolveStatePath } from "./paths.ts";
import { type PrivateFileAccess, PrivateFileAccessService } from "./private-file-access.ts";

const ioError = (operation: string, path: string, cause: unknown): StateStoreError =>
  new StateStoreError({ reason: "io", operation, path, cause });

const makeDiskBucketBackend = (privateFileAccess: PrivateFileAccess): StateBucketBackend => ({
  readBytes: (file, operation) =>
    Effect.tryPromise({
      try: () => Bun.file(file).bytes(),
      catch: (cause) => ioError(operation, file, cause),
    }).pipe(
      Effect.catchIf(
        (error) => isErrnoCode(error.cause, "ENOENT"),
        () => Effect.succeed<Uint8Array | null>(null),
      ),
    ),
  writeBytes: (file, body, operation, options) =>
    writeFileAtomicScoped(file, body, {
      ...options,
      privateFileAccess: privateFileAccess.enforce,
    }).pipe(Effect.mapError((cause) => ioError(operation, file, cause))),
  remove: (file) =>
    Effect.tryPromise({
      try: () => Bun.file(file).delete(),
      catch: (cause) => ioError("remove", file, cause),
    }).pipe(
      Effect.catchIf(
        (error) => isErrnoCode(error.cause, "ENOENT"),
        () => Effect.void,
      ),
    ),
  exists: (file) =>
    Effect.tryPromise({
      try: () => stat(file),
      catch: (cause) => ioError("exists", file, cause),
    }).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => isErrnoCode(error.cause, "ENOENT"),
        () => Effect.succeed(false),
      ),
    ),
  quarantine: (file, now) =>
    Effect.promise(() => rename(file, `${file}.corrupt-${now}`).catch(() => undefined)),
  withLock: (file, operation, body) => withAdvisoryLockUsing(privateFileAccess)(file, operation, body),
});

/**
 * Build the {@link StateStoreShape}: `open` resolves and containment-checks a
 * bucket's path (no read/write IO) and returns a {@link StateBucket} closure.
 */
export const makeStateStore = (options: {
  readonly privateFileAccess: PrivateFileAccess;
  readonly roots?: LandoRoots;
}): StateStoreShape => {
  const roots = options.roots;
  return StateStore.of({
    open: Effect.fn("StateStore.open")(
      <A, I>(spec: StateBucketSpec<A, I>): Effect.Effect<StateBucket<A>, StateStoreError> =>
        resolveStatePath(spec.root, spec.namespace, spec.key, "open", roots).pipe(
          Effect.map((resolved) =>
            buildStateBucket(spec, resolved.file, makeDiskBucketBackend(options.privateFileAccess)),
          ),
        ),
    ),
    withLock: Effect.fn("StateStore.withLock")(<A, E>(key: string, body: Effect.Effect<A, E>) =>
      resolveStatePath("userData", "operation-locks", key, "withLock", roots).pipe(
        Effect.flatMap((resolved) =>
          withAdvisoryLockUsing(options.privateFileAccess)(resolved.file, "withLock", body),
        ),
      ),
    ),
  });
};

export const layerWithPrivateFileAccess: Layer.Layer<StateStore, never, PrivateFileAccessService> =
  Layer.effect(
    StateStore,
    Effect.gen(function* () {
      const privateFileAccess = yield* PrivateFileAccessService;
      const paths = yield* Effect.serviceOption(PathsService);
      return makeStateStore({
        privateFileAccess,
        ...(Option.isSome(paths) ? { roots: paths.value.roots } : {}),
      });
    }),
  );

export const layer: Layer.Layer<StateStore> = layerWithPrivateFileAccess.pipe(
  Layer.provide(PrivateFileAccessService.layer),
);
