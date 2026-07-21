import { Effect, FiberRef } from "effect";

const processCwdLock = Effect.unsafeMakeSemaphore(1);
const processCwdLockDepth = FiberRef.unsafeMake(0, {
  fork: () => 0,
  join: (parentDepth) => parentDepth,
});

export const withProcessCwd = <A, E, R, EnterError>(
  root: string,
  use: Effect.Effect<A, E, R>,
  onEnterError: (cause: unknown) => EnterError,
): Effect.Effect<A, E | EnterError, R> =>
  Effect.suspend(() => {
    const run = Effect.suspend(() =>
      root === process.cwd()
        ? use
        : Effect.acquireUseRelease(
            Effect.try({
              try: () => {
                const original = process.cwd();
                process.chdir(root);
                return original;
              },
              catch: onEnterError,
            }),
            () => use,
            (original) => Effect.sync(() => process.chdir(original)),
          ),
    );
    return FiberRef.get(processCwdLockDepth).pipe(
      Effect.flatMap((depth) =>
        depth > 0 ? run : processCwdLock.withPermits(1)(Effect.locally(run, processCwdLockDepth, depth + 1)),
      ),
    );
  });
