import { randomUUID } from "node:crypto";
import { type FileHandle, chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { Effect, Ref } from "effect";

export const syncDirectory = async (path: string): Promise<void> => {
  // Windows does not support opening directories for fsync through this adapter.
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const removeIfPresent = (path: string): Promise<void> =>
  unlink(path)
    .then(() => undefined)
    .catch(() => undefined);

/**
 * Atomically replace `path` with `content` under the ambient `Scope`. The write
 * is uninterruptible (a started rename always finishes), and a finalizer cleans
 * up the temp file when the rename did not commit (interrupt or failure).
 *
 * The error channel surfaces the raw filesystem cause for callers to map.
 */
export const writeFileAtomicScoped = (
  path: string,
  content: string | Uint8Array,
  options: {
    readonly randomId?: () => string;
    readonly mode?: number;
    readonly syncFile?: (handle: FileHandle) => Promise<void>;
    readonly syncDirectory?: (path: string) => Promise<void>;
  } = {},
): Effect.Effect<void, unknown, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const tempPath = `${path}.tmp-${options.randomId?.() ?? randomUUID()}`;
      const committed = yield* Ref.make(false);

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (!(yield* Ref.get(committed))) {
            yield* Effect.promise(() => removeIfPresent(tempPath));
          }
        }),
      );

      yield* Effect.uninterruptible(
        Effect.tryPromise(async () => {
          await mkdir(dirname(path), { recursive: true });
          const handle = await open(tempPath, "w", options.mode);
          try {
            await handle.writeFile(content);
            // The create mode is masked by umask; chmod pins the requested permissions.
            if (options.mode !== undefined) await chmod(tempPath, options.mode);
            // Flush before rename to avoid publishing a torn live file after power loss.
            await (options.syncFile ?? ((h: FileHandle) => h.sync()))(handle);
          } finally {
            await handle.close();
          }
          await rename(tempPath, path);
          await (options.syncDirectory ?? syncDirectory)(dirname(path));
        }),
      );

      yield* Ref.set(committed, true);
    }),
  );
