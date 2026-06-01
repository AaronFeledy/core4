import { Effect } from "effect";

export interface ProcessCwdOptions<E> {
  readonly onEnterError: (cause: unknown) => E;
}

export const withProcessCwd = <A, E, R, CwdError>(
  dir: string,
  use: () => Effect.Effect<A, E, R>,
  options: ProcessCwdOptions<CwdError>,
): Effect.Effect<A, E | CwdError, R> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const original = process.cwd();
        process.chdir(dir);
        return original;
      },
      catch: options.onEnterError,
    }),
    () => use(),
    (original) => Effect.sync(() => process.chdir(original)),
  );
