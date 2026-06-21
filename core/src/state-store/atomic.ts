// Interrupt-safe, `Scope`-bound atomic file write. The existing
// `cache/atomic.ts` `writeFileAtomicViaRename` is a plain Promise: its temp
// cleanup runs only on a thrown error, never on `Effect.interrupt`, and the
// underlying Promise is not cancellable. This helper is the durable-state /
// managed-file write seam: it runs the `mkdir -> write temp -> rename` mutation
// inside an uninterruptible critical section and registers a `Scope` finalizer
// that removes the temp file if the rename never committed, so an interrupt
// leaves no torn live file and no orphan temp.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Effect, Ref } from "effect";

const removeIfPresent = (path: string): Promise<void> =>
  unlink(path)
    .then(() => undefined)
    .catch(() => undefined);

/**
 * Atomically replace `path` with `content` under the ambient `Scope`. The write
 * is uninterruptible (a started rename always finishes), and a finalizer cleans
 * up the temp file when the rename did not commit (interrupt or failure).
 *
 * The error channel surfaces the raw filesystem cause; callers map it into their
 * own tagged error (`ManagedFileError`, etc.).
 */
export const writeFileAtomicScoped = (
  path: string,
  content: string | Uint8Array,
  options: { readonly randomId?: () => string; readonly mode?: number } = {},
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
          await writeFile(tempPath, content, options.mode === undefined ? undefined : { mode: options.mode });
          // umask masks `writeFile`'s create mode; chmod before rename pins exact perms (0600 backups).
          if (options.mode !== undefined) await chmod(tempPath, options.mode);
          await rename(tempPath, path);
        }),
      );

      yield* Ref.set(committed, true);
    }),
  );
