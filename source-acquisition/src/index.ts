import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Clock, Effect } from "effect";
import { archiveAcquisition } from "./acquire-archive.ts";
import { gitAcquisition } from "./acquire-git.ts";
import { npmAcquisition } from "./acquire-npm.ts";
import { SourceAcquisitionError, displaySource } from "./errors.ts";
import { gc as runGc } from "./gc.ts";
import { resolveSourcesStoreRoot, sourceRecords } from "./records.ts";
import { io, makeStorage } from "./storage.ts";
import type { SourceSession, SourceStore, SourceStoreOptions } from "./types.ts";
export { SourceAcquisitionError, displaySource } from "./errors.ts";
export type * from "./types.ts";
export const makeSourceStore = (input: SourceStoreOptions): SourceStore => {
  let resolvedRoot: string | undefined;
  const storeRoot = Effect.fn("SourceStore.root")(function* () {
    if (resolvedRoot === undefined) resolvedRoot = yield* resolveSourcesStoreRoot(input.stateStore);
    return resolvedRoot;
  });
  return {
    gc: Effect.fn("SourceStore.gc")(function* (policy) {
      const root = yield* storeRoot();
      return yield* runGc(input, root, policy);
    }),
    session: Effect.gen(function* () {
      const createdAt = yield* Clock.currentTimeMillis;
      const lexicalRoot = yield* storeRoot();
      const canonicalRoot = yield* io("source store root", async () => {
        await mkdir(lexicalRoot, { recursive: true });
        return realpath(lexicalRoot);
      });
      resolvedRoot = canonicalRoot;
      const storage = makeStorage(input, canonicalRoot, { token: crypto.randomUUID(), createdAt });
      yield* Effect.acquireRelease(storage.initialize, () => storage.release.pipe(Effect.orDie));
      const archives = archiveAcquisition(input, storage);
      const registeredRoots = new Set<string>();
      return {
        ...gitAcquisition(input, storage),
        openArchive: archives.openArchive,
        acquireArchive: archives.acquireArchive,
        materializeArchive: Effect.fn("SourceSession.materializeArchive")(function* (pin, acquisition) {
          const cached = yield* storage.open({ kind: "archive", sha256: pin.sha256 }, pin, {
            verify: acquisition?.repair === true,
          });
          if (cached !== undefined) return cached;
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
        ...npmAcquisition(input, storage, archives),
        registerRoot: Effect.fn("SourceSession.registerRoot")(function* (lockfile: string) {
          const path = resolve(lockfile);
          if (registeredRoots.has(path)) return;
          const bucket = yield* sourceRecords(input.stateStore).root(path);
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
