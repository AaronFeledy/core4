// A minimal, generic durable JSON state bucket: one file, atomic replace, a
// `{ version, data }` envelope, schema-validated reads, corruption quarantine,
// and an optional advisory token lockfile for cross-process serialization of
// read-modify-write. It is the proven scratch-registry mechanics (versioned
// envelope + lock + quarantine + atomic write) published once as a reusable
// primitive so consumers never hand-roll their own registry/lock/quarantine.
//
// This is an INTERNAL core primitive, not the published `@lando/sdk` StateStore
// surface. When the SDK `StateStore` service lands it will wrap this seam; until
// then the managed-file ledger is realized through this generic bucket rather
// than a bespoke per-consumer store.

import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { writeFileAtomicScoped } from "./atomic.ts";

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;
const LOCK_ATTEMPTS = 200;

/** The single internal error a {@link JsonBucket} raises. */
export class StateBucketError extends Schema.TaggedError<StateBucketError>()("StateBucketError", {
  reason: Schema.Literal("io", "decode", "lock"),
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface JsonBucketSpec<A, I> {
  /** Absolute directory the bucket file lives in. */
  readonly dir: string;
  /** Bucket filename; no path separators. */
  readonly key: string;
  /** Document schema version stamped into the envelope. */
  readonly version: number;
  /** Schema the decoded `data` payload is validated against. */
  readonly schema: Schema.Schema<A, I>;
  /** Cross-process serialization of `update`. Defaults to `"none"`. */
  readonly lock?: "none" | "advisory";
  /** Corruption policy applied to an unreadable/invalid file. Defaults to `"quarantine"`. */
  readonly onCorrupt?: "discard" | "quarantine" | "fail";
  /** Value returned by `get`/`peek` when the file is absent. */
  readonly default?: A;
}

export interface JsonBucket<A> {
  readonly path: string;
  /** Read + validate; applies the corruption policy on a bad file. */
  readonly get: Effect.Effect<A | null, StateBucketError>;
  /** Read + validate but NEVER mutate on corruption (side-effect-free; for plan paths). */
  readonly peek: Effect.Effect<A | null, StateBucketError>;
  /** Atomic replace. */
  readonly set: (value: A) => Effect.Effect<void, StateBucketError>;
  /** Locked (when `advisory`) effectful read-modify-write. */
  readonly modify: <B, E>(
    f: (current: A | null) => Effect.Effect<readonly [B, A], E>,
  ) => Effect.Effect<B, E | StateBucketError>;
  /** Locked (when `advisory`) read-modify-write. */
  readonly update: (f: (current: A | null) => A) => Effect.Effect<A, StateBucketError>;
  readonly remove: Effect.Effect<void, StateBucketError>;
  readonly exists: Effect.Effect<boolean, StateBucketError>;
}

interface Envelope {
  readonly version: number;
  readonly data: unknown;
}

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && (cause as { code?: string }).code === "ENOENT";

const ioError = (path: string, cause: unknown): StateBucketError =>
  new StateBucketError({ reason: "io", path, cause });

export const openJsonBucket = <A, I>(spec: JsonBucketSpec<A, I>): Effect.Effect<JsonBucket<A>, never> =>
  Effect.sync(() => {
    const path = join(spec.dir, spec.key);
    const lockPath = `${path}.lock`;
    const onCorrupt = spec.onCorrupt ?? "quarantine";
    const fallback: A | null = spec.default ?? null;
    const decodeData = Schema.decodeUnknown(spec.schema);
    const encodeData = Schema.encode(spec.schema);

    const quarantine = Effect.promise(() =>
      rename(path, `${path}.corrupt-${Date.now()}`).catch(() => undefined),
    );

    const readRaw = (mutateOnCorrupt: boolean): Effect.Effect<A | null, StateBucketError> =>
      Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (cause) => ioError(path, cause) }).pipe(
        Effect.catchIf(
          (error) => isMissing(error.cause),
          () => Effect.succeed<A | null>(fallback),
        ),
        Effect.flatMap((content): Effect.Effect<A | null, StateBucketError> => {
          if (content === fallback || typeof content !== "string") return Effect.succeed(fallback);
          const handleCorrupt = (cause: unknown): Effect.Effect<A | null, StateBucketError> => {
            if (onCorrupt === "fail")
              return Effect.fail(new StateBucketError({ reason: "decode", path, cause }));
            const recover = Effect.succeed<A | null>(fallback);
            return mutateOnCorrupt && onCorrupt === "quarantine"
              ? quarantine.pipe(Effect.zipRight(recover))
              : recover;
          };
          let envelope: Envelope;
          try {
            envelope = JSON.parse(content) as Envelope;
          } catch (cause) {
            return handleCorrupt(cause);
          }
          if (typeof envelope !== "object" || envelope === null || typeof envelope.version !== "number") {
            return handleCorrupt(new Error("Malformed state envelope."));
          }
          if (envelope.version !== spec.version) {
            return Effect.succeed(fallback);
          }
          return decodeData(envelope.data).pipe(
            Effect.map((value): A | null => value),
            Effect.catchAll((cause) => handleCorrupt(cause)),
          );
        }),
      );

    const writeValue = (value: A): Effect.Effect<void, StateBucketError> =>
      encodeData(value).pipe(
        Effect.mapError((cause) => new StateBucketError({ reason: "decode", path, cause })),
        Effect.flatMap((encoded) => {
          const body = `${JSON.stringify({ version: spec.version, data: encoded }, null, 2)}\n`;
          return writeFileAtomicScoped(path, body).pipe(Effect.mapError((cause) => ioError(path, cause)));
        }),
      );

    const acquireLock = (token: string): Effect.Effect<void, StateBucketError> =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
          const acquired = yield* Effect.tryPromise({
            try: async () => {
              try {
                await mkdir(spec.dir, { recursive: true });
                const handle = await open(lockPath, "wx");
                await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
                await handle.close();
                return true;
              } catch (cause) {
                if ((cause as { code?: string }).code !== "EEXIST") throw cause;
                // Possible stale lock: take over when the holder is old or dead.
                const info = await stat(lockPath).catch(() => null);
                if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
                  await unlink(lockPath).catch(() => undefined);
                }
                return false;
              }
            },
            catch: (cause) => new StateBucketError({ reason: "lock", path: lockPath, cause }),
          });
          if (acquired) return;
          yield* Effect.sleep(`${LOCK_RETRY_MS} millis`);
        }
        return yield* Effect.fail(new StateBucketError({ reason: "lock", path: lockPath }));
      });

    const releaseLock = (token: string): Effect.Effect<void, never> =>
      Effect.promise(async () => {
        const current = await readFile(lockPath, "utf8").catch(() => null);
        if (current === null) return;
        try {
          if ((JSON.parse(current) as { token?: string }).token === token)
            await unlink(lockPath).catch(() => undefined);
        } catch {
          await unlink(lockPath).catch(() => undefined);
        }
      });

    const withLock = <B, E>(effect: Effect.Effect<B, E>): Effect.Effect<B, E | StateBucketError> => {
      if ((spec.lock ?? "none") === "none") return effect;
      const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return Effect.acquireUseRelease(
        acquireLock(token),
        () => effect,
        () => releaseLock(token),
      );
    };

    const modify = <B, E>(
      f: (current: A | null) => Effect.Effect<readonly [B, A], E>,
    ): Effect.Effect<B, E | StateBucketError> =>
      withLock(
        readRaw(true).pipe(
          Effect.flatMap((current) => f(current)),
          Effect.flatMap(([result, next]) => writeValue(next).pipe(Effect.as(result))),
        ),
      );

    const update = (f: (current: A | null) => A): Effect.Effect<A, StateBucketError> =>
      modify((current) =>
        Effect.sync(() => {
          const next = f(current);
          return [next, next] as const;
        }),
      );

    return {
      path,
      get: readRaw(true),
      peek: readRaw(false),
      set: writeValue,
      modify,
      update,
      remove: Effect.tryPromise({ try: () => unlink(path), catch: (cause) => ioError(path, cause) }).pipe(
        Effect.catchIf(
          (error) => isMissing(error.cause),
          () => Effect.void,
        ),
      ),
      exists: Effect.tryPromise({ try: () => stat(path), catch: (cause) => ioError(path, cause) }).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => isMissing(error.cause),
          () => Effect.succeed(false),
        ),
      ),
    } satisfies JsonBucket<A>;
  });
