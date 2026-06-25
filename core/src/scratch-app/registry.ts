import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { Context, Effect, Layer, Schema } from "effect";

import { ScratchAppError } from "@lando/sdk/errors";

import { writeFileAtomicViaRename } from "../cache/atomic.ts";
import { makeLandoPaths } from "../config/paths.ts";

const REGISTRY_VERSION = 1 as const;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;
const LOCK_ATTEMPTS = 50;

const ScratchSourceSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("fork") }),
  Schema.Struct({ kind: Schema.Literal("recipe"), ref: Schema.String }),
);

const RegistryEntrySchema = Schema.Struct({
  id: Schema.String,
  source: ScratchSourceSchema,
  isolate: Schema.Literal("none", "full"),
  detached: Schema.Boolean,
  ownerPid: Schema.optional(Schema.Number),
  rootPath: Schema.String,
  status: Schema.Literal("acquiring", "running", "stopping", "destroyed-pending-cleanup"),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const RegistryEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(REGISTRY_VERSION),
  entries: Schema.Array(RegistryEntrySchema),
});

export type ScratchRegistryEntry = typeof RegistryEntrySchema.Type;
export type ScratchRegistryEnvelope = typeof RegistryEnvelopeSchema.Type;

interface LockRecord {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: number;
}

export interface ScratchRegistryPaths {
  readonly base: string;
  readonly registry: string;
  readonly lock: string;
}

export const scratchRegistryPaths = (): ScratchRegistryPaths => {
  const paths = makeLandoPaths();
  return {
    base: paths.scratchDir,
    registry: paths.scratchRegistryFile,
    lock: paths.scratchRegistryLockFile,
  };
};

const scratchRegistryError = (operation: string, message: string, cause: unknown): ScratchAppError =>
  new ScratchAppError({ operation, message, cause });

const encode = (envelope: ScratchRegistryEnvelope): string => {
  const entries = [...envelope.entries].sort((left, right) => left.id.localeCompare(right.id));
  return `${JSON.stringify({ version: REGISTRY_VERSION, entries })}\n`;
};

const decode = (content: string): ScratchRegistryEnvelope =>
  Schema.decodeUnknownSync(RegistryEnvelopeSchema)(JSON.parse(content), { onExcessProperty: "error" });

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && (cause as { readonly code?: unknown }).code === "ENOENT";

const processIsDead = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (cause) {
    return (cause as { readonly code?: unknown }).code === "ESRCH";
  }
};

const readLock = async (path: string): Promise<LockRecord | null> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LockRecord;
  } catch (cause) {
    if (isMissing(cause)) return null;
    return null;
  }
};

const removeLockIfTokenMatches = async (path: string, token: string): Promise<void> => {
  const current = await readLock(path);
  if (current?.token === token) await unlink(path).catch(() => undefined);
};

export const acquireScratchRegistryLock = (
  paths: ScratchRegistryPaths = scratchRegistryPaths(),
): Effect.Effect<{ readonly token: string; readonly release: Effect.Effect<void> }, ScratchAppError> =>
  Effect.tryPromise({
    try: async () => {
      const token = crypto.randomUUID();
      await mkdir(paths.base, { recursive: true });
      for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
        try {
          const handle = await open(paths.lock, "wx");
          await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }));
          await handle.close();
          return {
            token,
            release: Effect.promise(() => removeLockIfTokenMatches(paths.lock, token)),
          };
        } catch (cause) {
          if (!isMissing(cause) && (cause as { readonly code?: unknown }).code !== "EEXIST") throw cause;
          const current = await readLock(paths.lock);
          if (
            current === null ||
            Date.now() - current.createdAt > LOCK_STALE_MS ||
            processIsDead(current.pid)
          ) {
            await unlink(paths.lock).catch(() => undefined);
          } else {
            await Bun.sleep(LOCK_RETRY_MS);
          }
        }
      }
      throw new Error(`Timed out waiting for scratch registry lock at ${paths.lock}`);
    },
    catch: (cause) =>
      scratchRegistryError("registry.lock", "Unable to acquire the scratch registry lock.", cause),
  });

const withLock = <A>(
  paths: ScratchRegistryPaths,
  use: Effect.Effect<A, ScratchAppError>,
): Effect.Effect<A, ScratchAppError> =>
  Effect.acquireUseRelease(
    acquireScratchRegistryLock(paths),
    () => use,
    (lock) => lock.release,
  );

const readEnvelope = (paths: ScratchRegistryPaths): Effect.Effect<ScratchRegistryEnvelope, ScratchAppError> =>
  Effect.tryPromise({
    try: () => readFile(paths.registry, "utf8"),
    catch: (cause) =>
      scratchRegistryError("registry.read", "Unable to read the scratch registry file.", cause),
  }).pipe(
    Effect.catchIf(
      (error) => isMissing(error.cause),
      () => Effect.succeed(null),
    ),
    Effect.flatMap((content) => {
      if (content === null) return Effect.succeed({ version: REGISTRY_VERSION, entries: [] });
      return Effect.try({
        try: () => decode(content),
        catch: (cause) =>
          scratchRegistryError(
            "registry.decode",
            "Scratch registry was corrupt and has been quarantined.",
            cause,
          ),
      }).pipe(
        Effect.catchAll((error) =>
          Effect.tryPromise({
            try: () => rename(paths.registry, `${paths.registry}.corrupt-${Date.now()}`),
            catch: () => error,
          }).pipe(Effect.ignore, Effect.as({ version: REGISTRY_VERSION, entries: [] })),
        ),
      );
    }),
  );

const writeEnvelope = (
  paths: ScratchRegistryPaths,
  envelope: ScratchRegistryEnvelope,
): Effect.Effect<void, ScratchAppError> =>
  Effect.tryPromise({
    try: () => writeFileAtomicViaRename(paths.registry, encode(envelope)),
    catch: (cause) => scratchRegistryError("registry.write", "Unable to write the scratch registry.", cause),
  });

export interface ScratchRegistryService {
  readonly read: () => Effect.Effect<ScratchRegistryEnvelope, ScratchAppError>;
  readonly upsert: (entry: ScratchRegistryEntry) => Effect.Effect<void, ScratchAppError>;
  readonly remove: (id: string) => Effect.Effect<void, ScratchAppError>;
  readonly list: () => Effect.Effect<ReadonlyArray<ScratchRegistryEntry>, ScratchAppError>;
  readonly get: (id: string) => Effect.Effect<ScratchRegistryEntry | undefined, ScratchAppError>;
}

export class ScratchRegistry extends Context.Tag("@lando/core/ScratchRegistry")<
  ScratchRegistry,
  ScratchRegistryService
>() {}

export const makeScratchRegistry = (
  paths: ScratchRegistryPaths = scratchRegistryPaths(),
): ScratchRegistryService => {
  const read = () => readEnvelope(paths);
  const list = () => read().pipe(Effect.map((envelope) => envelope.entries));
  const get = (id: string) => list().pipe(Effect.map((entries) => entries.find((entry) => entry.id === id)));
  const upsert = (entry: ScratchRegistryEntry) =>
    withLock(
      paths,
      read().pipe(
        Effect.map((envelope) => ({
          version: REGISTRY_VERSION,
          entries: [...envelope.entries.filter((current) => current.id !== entry.id), entry],
        })),
        Effect.flatMap((envelope) => writeEnvelope(paths, envelope)),
      ),
    );
  const remove = (id: string) =>
    withLock(
      paths,
      read().pipe(
        Effect.map((envelope) => ({
          version: REGISTRY_VERSION,
          entries: envelope.entries.filter((entry) => entry.id !== id),
        })),
        Effect.flatMap((envelope) => writeEnvelope(paths, envelope)),
      ),
    );
  return { read, upsert, remove, list, get };
};

export const ScratchRegistryLive = Layer.effect(
  ScratchRegistry,
  Effect.sync(() => makeScratchRegistry()),
);
