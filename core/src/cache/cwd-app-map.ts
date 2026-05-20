import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deserialize, serialize } from "node:v8";

import { Effect, Schema } from "effect";

import { CacheError } from "@lando/sdk/errors";

import { CORE_VERSION } from "../version.ts";

const MAGIC = Buffer.from("LCWM");
const HEADER_BYTES = 44;
const CACHE_VERSION = 1n;
const DEFAULT_MAX_ENTRIES = 256;

export const CWD_APP_MAP_CACHE_FILE = "cwd-app-map.bin";

export const CwdAppMapEntry = Schema.Struct({
  cwd: Schema.String,
  appRoot: Schema.String,
  primaryLandofilePath: Schema.String,
  mtimeNs: Schema.Number,
  sizeBytes: Schema.Number,
  lastUsedAt: Schema.Number,
});
export type CwdAppMapEntry = typeof CwdAppMapEntry.Type;

export const CwdAppMapCache = Schema.Struct({
  landoVersion: Schema.String,
  entries: Schema.Array(CwdAppMapEntry),
});
export type CwdAppMapCache = typeof CwdAppMapCache.Type;

const cachePath = (cacheRoot: string): string => join(cacheRoot, CWD_APP_MAP_CACHE_FILE);

const cacheError = (path: string, message: string, cause?: unknown): CacheError =>
  new CacheError({
    message: `${message} Delete ${path} or run \`lando app:cache:refresh\` to rebuild the cwd-app-map cache.`,
    key: "cwd-app-map",
    path,
    ...(cause === undefined ? {} : { cause }),
  });

const sha256 = (payload: Uint8Array): Buffer => createHash("sha256").update(payload).digest();

const encode = (cache: CwdAppMapCache): Uint8Array => {
  const payload = serialize(cache);
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeBigUInt64BE(CACHE_VERSION, 4);
  sha256(payload).copy(header, 12);
  return Buffer.concat([header, payload]);
};

const decode = (path: string, bytes: Uint8Array): Effect.Effect<CwdAppMapCache, CacheError> =>
  Effect.try({
    try: () => {
      const buffer = Buffer.from(bytes);
      if (buffer.length <= HEADER_BYTES) {
        throw new Error("cache file is shorter than the required binary header");
      }
      if (!buffer.subarray(0, 4).equals(MAGIC)) {
        throw new Error("cache magic header does not match cwd-app-map");
      }
      if (buffer.readBigUInt64BE(4) !== CACHE_VERSION) {
        throw new Error("cache schema version is not supported");
      }
      const expectedHash = buffer.subarray(12, HEADER_BYTES);
      const payload = buffer.subarray(HEADER_BYTES);
      if (!sha256(payload).equals(expectedHash)) {
        throw new Error("cache payload hash does not match header");
      }
      return Schema.decodeUnknownSync(CwdAppMapCache)(deserialize(payload));
    },
    catch: (cause) => cacheError(path, `Corrupt cwd-app-map cache at ${path}.`, cause),
  });

const normalizeEntries = (
  entries: ReadonlyArray<CwdAppMapEntry>,
  maxEntries: number,
): ReadonlyArray<CwdAppMapEntry> =>
  [...new Map(entries.map((entry) => [entry.cwd, entry])).values()]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, maxEntries);

export const readCwdAppMap = (cacheRoot: string): Effect.Effect<CwdAppMapCache | null, CacheError> =>
  Effect.gen(function* () {
    const path = cachePath(cacheRoot);
    const bytes = yield* Effect.tryPromise({
      try: () => readFile(path),
      catch: (cause) => cacheError(path, `Failed to read cwd-app-map cache at ${path}.`, cause),
    }).pipe(
      Effect.catchIf(
        (error) =>
          typeof error.cause === "object" &&
          error.cause !== null &&
          (error.cause as { code?: unknown }).code === "ENOENT",
        () => Effect.succeed(null),
      ),
    );
    if (bytes === null) return null;
    return yield* decode(path, bytes);
  });

export const listCwdAppMapEntries = (
  cacheRoot: string,
): Effect.Effect<ReadonlyArray<CwdAppMapEntry>, CacheError> =>
  Effect.map(readCwdAppMap(cacheRoot), (cache) => cache?.entries ?? []);

export const writeCwdAppMapEntry = (input: {
  readonly cacheRoot: string;
  readonly entry: Omit<CwdAppMapEntry, "lastUsedAt"> & { readonly lastUsedAt?: number };
  readonly maxEntries?: number;
}): Effect.Effect<void, CacheError> =>
  Effect.gen(function* () {
    const existing = yield* readCwdAppMap(input.cacheRoot).pipe(Effect.catchAll(() => Effect.succeed(null)));
    const entry: CwdAppMapEntry = {
      ...input.entry,
      lastUsedAt: input.entry.lastUsedAt ?? Date.now(),
    };
    const entries = normalizeEntries(
      [entry, ...(existing?.entries ?? [])],
      input.maxEntries ?? DEFAULT_MAX_ENTRIES,
    );
    const path = cachePath(input.cacheRoot);
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, encode({ landoVersion: CORE_VERSION, entries }));
      },
      catch: (cause) => cacheError(path, `Failed to write cwd-app-map cache at ${path}.`, cause),
    });
  });

export const readCwdAppMapEntry = (input: {
  readonly cacheRoot: string;
  readonly cwd: string;
}): Effect.Effect<CwdAppMapEntry | null, CacheError> =>
  Effect.map(
    readCwdAppMap(input.cacheRoot),
    (cache) => cache?.entries.find((entry) => entry.cwd === input.cwd) ?? null,
  );

export const deleteCwdAppMapEntry = (input: {
  readonly cacheRoot: string;
  readonly cwd: string;
}): Effect.Effect<void, CacheError> =>
  Effect.gen(function* () {
    const existing = yield* readCwdAppMap(input.cacheRoot);
    if (existing === null) return;
    const entries = existing.entries.filter((entry) => entry.cwd !== input.cwd);
    const path = cachePath(input.cacheRoot);
    if (entries.length === 0) {
      yield* Effect.tryPromise({
        try: () => rm(path, { force: true }),
        catch: (cause) => cacheError(path, `Failed to delete cwd-app-map cache at ${path}.`, cause),
      });
      return;
    }
    yield* Effect.tryPromise({
      try: () => writeFile(path, encode({ ...existing, entries })),
      catch: (cause) => cacheError(path, `Failed to write cwd-app-map cache at ${path}.`, cause),
    });
  });
