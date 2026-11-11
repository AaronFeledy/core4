import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StateStoreError, isErrnoCode } from "@lando/sdk/errors";
import type { TunnelSession } from "@lando/sdk/schema";
import { PathsService, StateStore } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";

import {
  TUNNEL_REGISTRY_VERSION,
  TunnelRegistryEntries,
  type TunnelRegistryEntry,
  migrateTunnelRegistryEntries,
} from "./registry-migrate.ts";

const registrySpec = {
  root: "userData",
  namespace: "tunnels",
  key: "registry.bin",
  schema: TunnelRegistryEntries,
  version: TUNNEL_REGISTRY_VERSION,
  codec: "binary",
  lock: "advisory",
  default: [] as TunnelRegistryEntries,
  onVersionMismatch: migrateTunnelRegistryEntries,
} as const;

const stateError = (operation: string, path: string, cause: unknown): StateStoreError =>
  new StateStoreError({
    reason: "io",
    operation,
    path,
    cause,
    remediation: `Fix permissions on tunnel registry path ${path}, then retry the share command.`,
  });

const pidIsAlive = (pid: number): boolean => {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists but belongs to another user.
    return !isErrnoCode(cause, "ESRCH");
  }
};

const partitionEntries = (
  entries: ReadonlyArray<TunnelRegistryEntry>,
  activeSessionIds: ReadonlySet<string>,
) => {
  const live: Array<TunnelRegistryEntry> = [];
  const staleIds: string[] = [];
  for (const entry of entries) {
    if (pidIsAlive(entry.pid) || activeSessionIds.has(entry.session.id)) live.push(entry);
    else staleIds.push(entry.session.id);
  }
  return { live, staleIds };
};

const writeRunArtifacts = Effect.fnUntraced(function* (session: TunnelRegistryEntry["session"]) {
  const dir = (yield* PathsService).tunnelRunDir;
  const path = join(dir, `${session.id}.json`);
  const pidPath = join(dir, `${session.id}.pid`);
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(path, `${JSON.stringify({ session, pid: process.pid })}\n`, "utf8");
      await writeFile(pidPath, `${process.pid}\n`, "utf8");
    },
    catch: (cause) => stateError("write-tunnel-run-artifacts", path, cause),
  });
});

const removeRunArtifacts = Effect.fnUntraced(function* (sessionId: string) {
  const dir = (yield* PathsService).tunnelRunDir;
  yield* Effect.tryPromise({
    try: async () => {
      await rm(join(dir, `${sessionId}.json`), { force: true });
      await rm(join(dir, `${sessionId}.pid`), { force: true });
      await rm(join(dir, `${sessionId}.sock`), { force: true });
    },
    catch: (cause) => stateError("remove-tunnel-run-artifacts", dir, cause),
  });
});

const bucket = Effect.flatMap(StateStore, (store) => store.open(registrySpec));

export const recordTunnelSession = Effect.fn("TunnelRegistry.recordTunnelSession")(function* (
  session: TunnelSession,
): Effect.fn.Return<void, StateStoreError, StateStore | PathsService> {
  const registry = yield* bucket;
  const now = DateTime.formatIso(yield* DateTime.now);
  const { status: _status, ...registration } = session;
  yield* registry.update((current) => {
    const next = partitionEntries(current ?? [], new Set()).live.filter(
      (entry) => entry.session.id !== session.id,
    );
    return [...next, { session: registration, pid: process.pid, updatedAt: now }];
  });
  yield* writeRunArtifacts(registration);
});

export const reconcileTunnelRegistry = Effect.fn("TunnelRegistry.reconcileTunnelRegistry")(function* (
  activeSessionIds: ReadonlySet<string> = new Set(),
): Effect.fn.Return<ReadonlyArray<TunnelSession>, StateStoreError, StateStore | PathsService> {
  const registry = yield* bucket;
  const reconciled = yield* registry.modify((current) => {
    const { live, staleIds } = partitionEntries(current ?? [], activeSessionIds);
    return [
      { sessions: live.map((entry) => ({ ...entry.session, status: "ready" as const })), staleIds },
      live,
    ];
  });
  for (const staleId of reconciled.staleIds) yield* removeRunArtifacts(staleId);
  return reconciled.sessions;
});

export const removeTunnelSession = Effect.fn("TunnelRegistry.removeTunnelSession")(function* (
  sessionId: string,
): Effect.fn.Return<void, StateStoreError, StateStore | PathsService> {
  const registry = yield* bucket;
  yield* registry.update((current) =>
    partitionEntries(current ?? [], new Set()).live.filter((entry) => entry.session.id !== sessionId),
  );
  yield* removeRunArtifacts(sessionId);
});
