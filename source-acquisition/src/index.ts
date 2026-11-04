import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Clock, Effect } from "effect";
import { archiveAcquisition } from "./acquire-archive.ts";
import { gitAcquisition } from "./acquire-git.ts";
import { npmAcquisition } from "./acquire-npm.ts";
import { SourceAcquisitionError, displaySource } from "./errors.ts";
import { gc as runGc } from "./gc.ts";
import { sourceRecords } from "./records.ts";
import { io, makeStorage } from "./storage.ts";
import type { SourceSession, SourceStore, SourceStoreOptions } from "./types.ts";
export { SourceAcquisitionError, displaySource } from "./errors.ts";
export type * from "./types.ts";
export const makeSourceStore = (input: SourceStoreOptions): SourceStore => {
  const options = { ...input, root: resolve(input.root) };
  return {
    root: options.root,
    gc: (policy) => runGc(options, policy),
    session: Effect.gen(function* () {
      const createdAt = yield* Clock.currentTimeMillis;
      const canonicalRoot = yield* io("source store root", async () => {
        await mkdir(options.root, { recursive: true });
        return realpath(options.root);
      });
      const storage = makeStorage(
        { ...options, root: canonicalRoot },
        { token: crypto.randomUUID(), createdAt },
      );
      yield* Effect.acquireRelease(storage.initialize, () => storage.release.pipe(Effect.orDie));
      const archives = archiveAcquisition(options, storage);
      const registeredRoots = new Set<string>();
      return {
        ...gitAcquisition(options, storage),
        openArchive: archives.openArchive,
        acquireArchive: archives.acquireArchive,
        materializeArchive: Effect.fn("SourceSession.materializeArchive")(function* (pin, acquisition) {
          if (!acquisition?.repair) {
            const cached = yield* storage.open({ kind: "archive", sha256: pin.sha256 }, pin);
            if (cached !== undefined) return cached;
          }
          if (acquisition?.network === false)
            return yield* Effect.fail(
              new SourceAcquisitionError({
                message: "Pinned archive source is not cached.",
                source: displaySource(pin.url),
                kind: "offline-miss",
                remediation: "Acquire this exact archive with network access first.",
              }),
            );
          return yield* archives.acquireArchive(pin, acquisition);
        }),
        ...npmAcquisition(options, storage, archives),
        registerRoot: Effect.fn("SourceSession.registerRoot")(function* (lockfile: string) {
          const path = resolve(lockfile);
          if (registeredRoots.has(path)) return;
          const bucket = yield* sourceRecords(options.stateStore).root(path);
          const updatedAt = yield* Clock.currentTimeMillis;
          yield* storage.locked(
            Effect.gen(function* () {
              if (!(yield* bucket.exists)) yield* bucket.set({ lockfile: path, updatedAt });
            }),
          );
          registeredRoots.add(path);
        }),
      } satisfies SourceSession;
    }),
  };
};
