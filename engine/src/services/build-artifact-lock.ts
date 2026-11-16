import { AbsolutePath } from "@lando/sdk/schema";
import { EventService, PathsService } from "@lando/sdk/services";
import { acquireAdvisoryLockAt } from "@lando/state-store/lock";
import { resolveStatePath } from "@lando/state-store/paths";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Option, Semaphore } from "effect";
import { resolveAppLockTimeoutMs } from "../operations/app-mutation-lock.ts";

// One command's builds take this lock concurrently. The file lock serializes processes; this gate
// lets only one fiber per process touch the lock file, because on Windows fibers racing to create,
// read, and unlink it fail with sharing errors instead of waiting.
const inProcessGates = new Map<string, Semaphore.Semaphore>();

const gateFor = (lockPath: string): Semaphore.Semaphore => {
  const existing = inProcessGates.get(lockPath);
  if (existing !== undefined) return existing;
  const created = Semaphore.makeUnsafe(1);
  inProcessGates.set(lockPath, created);
  return created;
};

const announceWait = Effect.gen(function* () {
  const events = yield* Effect.serviceOption(EventService);
  if (events._tag === "Some")
    yield* events.value
      .publish({
        _tag: "message.warn",
        body: "Waiting for another Lando command to finish built image cleanup.",
        timestamp: yield* DateTime.now,
      })
      .pipe(Effect.ignore);
});

export const withBuiltArtifactsLock = Effect.fnUntraced(function* <A, E, R>(body: Effect.Effect<A, E, R>) {
  const paths = yield* PathsService;
  const resolved = yield* resolveStatePath(
    { path: AbsolutePath.make(paths.roots.userCacheRoot) },
    undefined,
    "built-artifacts",
    "built-artifacts",
  );
  const lockPath = `${resolved.file}.lock`;
  // The access worker must outlive the lock scope: the release finalizer verifies the lock file
  // through it, and on Windows a closed worker fails that check and leaves the lock behind.
  const locked = (onWait: Effect.Effect<void> | undefined) =>
    Effect.scoped(
      Effect.gen(function* () {
        const access = yield* PrivateFileAccessService;
        yield* Effect.acquireRelease(
          acquireAdvisoryLockAt(lockPath, "built-artifacts", {
            timeoutMs: resolveAppLockTimeoutMs(),
            privateFileAccess: access,
            ...(onWait === undefined ? {} : { onWait }),
          }),
          (held) => held.release,
        );
        return yield* body;
      }),
    ).pipe(Effect.provide(PrivateFileAccessService.layer));
  const gate = gateFor(lockPath);
  const uncontended = yield* gate.withPermitsIfAvailable(1)(locked(announceWait));
  if (Option.isSome(uncontended)) return uncontended.value;
  yield* announceWait;
  return yield* gate.withPermits(1)(locked(undefined));
});
