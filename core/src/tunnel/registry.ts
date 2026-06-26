import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { StateStoreError } from "@lando/sdk/errors";
import { type TunnelSession, TunnelSession as TunnelSessionSchema } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";

import { makeLandoPaths } from "../config/paths.ts";

const TunnelRegistryEntry = Schema.Struct({
  session: TunnelSessionSchema,
  pid: Schema.Number.pipe(Schema.int()),
  updatedAt: Schema.String,
});

const TunnelRegistryEntries = Schema.Array(TunnelRegistryEntry);

type TunnelRegistryEntry = typeof TunnelRegistryEntry.Type;
type TunnelRegistryEntries = typeof TunnelRegistryEntries.Type;

const registrySpec = {
  root: "userCache",
  namespace: "tunnels",
  key: "registry.bin",
  schema: TunnelRegistryEntries,
  version: 1,
  codec: "binary",
  lock: "advisory",
  default: [] as TunnelRegistryEntries,
} as const;

const runDir = (): string => makeLandoPaths().tunnelRunDir;

const stateError = (operation: string, path: string, cause: unknown): StateStoreError =>
  new StateStoreError({ reason: "io", operation, path, cause });

const pidIsAlive = (pid: number): boolean => {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const reconcileEntries = (entries: ReadonlyArray<TunnelRegistryEntry>): TunnelRegistryEntries =>
  entries.filter((entry) => pidIsAlive(entry.pid));

const writeRunArtifacts = (session: TunnelSession): Effect.Effect<void, StateStoreError> => {
  const dir = runDir();
  const path = join(dir, `${session.id}.json`);
  const pidPath = join(dir, `${session.id}.pid`);
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(path, `${JSON.stringify({ session, pid: process.pid })}\n`, "utf8");
      await writeFile(pidPath, `${process.pid}\n`, "utf8");
    },
    catch: (cause) => stateError("write-tunnel-run-artifacts", path, cause),
  });
};

const removeRunArtifacts = (sessionId: string): Effect.Effect<void, StateStoreError> => {
  const dir = runDir();
  return Effect.tryPromise({
    try: async () => {
      await rm(join(dir, `${sessionId}.json`), { force: true });
      await rm(join(dir, `${sessionId}.pid`), { force: true });
      await rm(join(dir, `${sessionId}.sock`), { force: true });
    },
    catch: (cause) => stateError("remove-tunnel-run-artifacts", dir, cause),
  });
};

const bucket = Effect.flatMap(StateStore, (store) => store.open(registrySpec));

export const recordTunnelSession = (
  session: TunnelSession,
): Effect.Effect<void, StateStoreError, StateStore> =>
  Effect.gen(function* () {
    const registry = yield* bucket;
    const now = new Date().toISOString();
    yield* registry.update((current) => {
      const next = reconcileEntries(current ?? []).filter((entry) => entry.session.id !== session.id);
      return [...next, { session, pid: process.pid, updatedAt: now }];
    });
    yield* writeRunArtifacts(session);
  });

export const reconcileTunnelRegistry = (): Effect.Effect<
  ReadonlyArray<TunnelSession>,
  StateStoreError,
  StateStore
> =>
  Effect.gen(function* () {
    const registry = yield* bucket;
    return yield* registry.modify((current) => {
      const next = reconcileEntries(current ?? []);
      return [next.map((entry) => entry.session), next];
    });
  });

export const removeTunnelSession = (sessionId: string): Effect.Effect<void, StateStoreError, StateStore> =>
  Effect.gen(function* () {
    const registry = yield* bucket;
    yield* registry.update((current) =>
      reconcileEntries(current ?? []).filter((entry) => entry.session.id !== sessionId),
    );
    yield* removeRunArtifacts(sessionId);
  });
