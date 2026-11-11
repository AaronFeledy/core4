import { parseLockEntriesFromText } from "@lando/landofile/include-lockfile";
import { classify, parseNpmInclude } from "@lando/landofile/include-source";
import { FileSystem, StateStore } from "@lando/sdk/services";
import { displaySource, makeSourceStore } from "@lando/source-acquisition";
import {
  LockKey,
  type LockKeysResult,
  type SourceGcReport,
  SourceGcReportSchema,
} from "@lando/source-acquisition/gc";
import { Effect, Schema } from "effect";

export type { SourceGcReport };
export { SourceGcReportSchema as SourceGcReportResultSchema };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const lockKeysFromEntries = (entries: ReturnType<typeof parseLockEntriesFromText>): readonly LockKey[] => {
  const keys: LockKey[] = [];
  for (const entry of entries) {
    const kind = classify(entry.source);
    if (kind === "git") {
      keys.push(Schema.decodeUnknownSync(LockKey)({ kind: "git", commit: entry.resolved }));
      continue;
    }
    if (kind !== "npm") continue;
    const { packageName: name } = parseNpmInclude({ source: entry.source });
    keys.push(Schema.decodeUnknownSync(LockKey)({ kind: "npm", name, version: entry.resolved }));
  }
  return keys;
};

const detailOf = (cause: unknown): string =>
  displaySource(cause instanceof Error ? cause.message : String(cause));

export const makeReadLockKeys =
  (fs: FileSystem["Service"]): ((lockfile: string) => Effect.Effect<LockKeysResult>) =>
  (lockfile) =>
    fs.readText(lockfile).pipe(
      Effect.map((text): LockKeysResult => {
        try {
          return { status: "ok", keys: lockKeysFromEntries(parseLockEntriesFromText(text)) };
        } catch (cause) {
          return { status: "corrupt", detail: detailOf(cause) };
        }
      }),
      Effect.catchTag("FileNotFoundError", () => Effect.succeed({ status: "missing" as const })),
      Effect.catch((error) => Effect.succeed({ status: "unreadable" as const, detail: detailOf(error) })),
    );

export interface SourceCacheGcOptions {
  readonly prune?: boolean;
  readonly olderThanDays?: number;
}

export const sourceCacheGc = Effect.fn("Operations.sourceCacheGc")(function* (
  options: SourceCacheGcOptions = {},
) {
  const stateStore = yield* StateStore;
  const fs = yield* FileSystem;
  const prune = options.prune === true;
  const olderThanDays = options.olderThanDays ?? 30;
  const store = makeSourceStore({
    stateStore,
    transports: {},
  });
  return yield* store.gc({
    prune,
    olderThanMs: olderThanDays * MS_PER_DAY,
    readLockKeys: makeReadLockKeys(fs),
  });
});
