import { rm } from "node:fs/promises";

interface CleanupOptions {
  readonly platform?: NodeJS.Platform;
  readonly remove?: (root: string) => Promise<void>;
  readonly wait?: (milliseconds: number) => Promise<unknown>;
}

const windowsLockCodes = new Set(["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]);

export const removeAcceptanceRoot = async (root: string, options: CleanupOptions = {}): Promise<void> => {
  const remove = options.remove ?? ((path: string) => rm(path, { recursive: true, force: true }));
  const wait = options.wait ?? Bun.sleep;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await remove(root);
      return;
    } catch (cause) {
      const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
      if (
        (options.platform ?? process.platform) !== "win32" ||
        typeof code !== "string" ||
        !windowsLockCodes.has(code) ||
        attempt === 19
      )
        throw cause;
      // Retry transient Windows lock errors within a bounded cleanup window.
      await wait(250);
    }
  }
};

export const withAcceptanceCleanup = async <T>(
  roots: ReadonlyArray<string>,
  run: () => Promise<T>,
  remove: (root: string) => Promise<void> = removeAcceptanceRoot,
): Promise<T> => {
  const outcome = await Promise.resolve()
    .then(run)
    .then(
      (value) => ({ success: true as const, value }),
      (cause: unknown) => ({ success: false as const, cause }),
    );
  const results = await Promise.allSettled(roots.map((root) => Promise.resolve().then(() => remove(root))));
  const errors: unknown[] = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length > 0) {
    if (!outcome.success) errors.unshift(outcome.cause);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, "OpenTUI acceptance and cleanup failures");
  }
  if (!outcome.success) throw outcome.cause;
  return outcome.value;
};
