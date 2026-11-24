import { readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RootOverrides } from "@lando/paths";
import { makeLandoPaths, sanitizeAppName } from "@lando/paths";
import type { AppRef } from "@lando/sdk/schema";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { type WorkerClaim, changeWorkerClaim, withDetachedWorkerLock } from "../detached-worker/claim.ts";
import { isOwnerOnlyRecordFile } from "../detached-worker/state-file.ts";
import { resetHostProxyRunDirectory } from "./run-directory.ts";
import { terminateControlRecord } from "./worker-control.ts";
import {
  readLegacyWorkerRecordAt,
  readWorkerRecordAt,
  readWorkerRecordStateAt,
  withWorkerRecordLock,
  workerStatePath,
} from "./worker-state-file.ts";

export interface TerminateHostProxyWorkerOptions {
  readonly paths?: RootOverrides;
  readonly terminateProcess?: (pid: number, signal: NodeJS.Signals) => Promise<void>;
  readonly privateFileAccess: PrivateFileAccess;
}

export type TerminateOwnershipResult = "terminated" | "absent";

/**
 * Retiring the app's host-proxy removes the whole run directory. Replacing its worker keeps the
 * container-facing directory, which running containers bind, so the successor's session reaches
 * them without recreating them.
 */
type RunDirRemoval = "retire" | "replace";

const removeRunDir = (
  app: Pick<AppRef, "id" | "root">,
  paths: RootOverrides | undefined,
  removal: RunDirRemoval,
): Effect.Effect<void> => {
  const runDir = dirname(workerStatePath(app, paths));
  return Effect.promise(() =>
    removal === "retire" ? rm(runDir, { recursive: true, force: true }) : resetHostProxyRunDirectory(runDir),
  );
};

const removeHostProxyClaim = (
  claim: WorkerClaim,
  app: Pick<AppRef, "id" | "root">,
  options: TerminateHostProxyWorkerOptions,
  removal: RunDirRemoval,
) =>
  isOwnerOnlyRecordFile(claim.path, options.privateFileAccess).pipe(
    Effect.flatMap((trusted) =>
      trusted ? readWorkerRecordStateAt(claim.path) : Effect.succeed({ _tag: "malformed" as const }),
    ),
    Effect.flatMap((state) => {
      const reap = changeWorkerClaim(claim, "reap-stale", removeRunDir(app, options.paths, removal)).pipe(
        Effect.as("absent" as const),
      );
      switch (state._tag) {
        case "absent":
        case "malformed":
          return reap;
        case "current":
        case "legacy": {
          const root = state._tag === "current" ? state.record.appRoot : state.appRoot;
          if (state.record.appId !== app.id || (root !== undefined && root !== app.root)) return reap;
          return terminateControlRecord(
            state.record,
            { ...options, claim },
            removeRunDir(app, options.paths, removal),
          ).pipe(Effect.as("terminated" as const));
        }
        default: {
          const exhaustive: never = state;
          return exhaustive;
        }
      }
    }),
  );

/** Replaces whatever worker the held claim names; the caller already owns the record lock. */
export const replaceExistingHostProxyWorker = (
  claim: WorkerClaim,
  app: Pick<AppRef, "id" | "root">,
  options: TerminateHostProxyWorkerOptions,
) => removeHostProxyClaim(claim, app, options, "replace").pipe(Effect.asVoid);

export const terminateOwnedHostProxyWorker = (
  app: Pick<AppRef, "id" | "root">,
  options: TerminateHostProxyWorkerOptions,
): Effect.Effect<TerminateOwnershipResult> =>
  withWorkerRecordLock(
    app,
    options.paths,
    (claim) => removeHostProxyClaim(claim, app, options, "retire"),
    options.privateFileAccess,
  ).pipe(Effect.catch(() => Effect.succeed("absent" as const)));

export const removeOwnedHostProxyWorkerState = (
  app: Pick<AppRef, "id" | "root">,
  paths: RootOverrides | undefined,
  options: Omit<TerminateHostProxyWorkerOptions, "paths">,
): Effect.Effect<void, never> =>
  terminateOwnedHostProxyWorker(app, { ...options, ...(paths === undefined ? {} : { paths }) }).pipe(
    Effect.asVoid,
  );

export const terminateOwnedHostProxyWorkersInRoot = Effect.fnUntraced(
  function* (
    userDataRoot: string,
    options: Omit<TerminateHostProxyWorkerOptions, "paths">,
  ): Effect.fn.Return<void, never> {
    const paths = makeLandoPaths({ userDataRoot });
    const entries = yield* Effect.promise(() =>
      readdir(paths.hostProxyRunRoot, { withFileTypes: true }).catch(() => []),
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runDir = resolve(paths.hostProxyRunRoot, entry.name);
      if (
        entry.name.endsWith("-ssh-agent") ||
        entry.name.endsWith("-gpg-agent") ||
        runDir === resolve(paths.tunnelRunDir)
      )
        continue;
      const recordPath = resolve(runDir, "worker.json");
      yield* withDetachedWorkerLock(
        {
          path: recordPath,
          label: "host-proxy-worker",
          paths: { userDataRoot },
          privateFileAccess: options.privateFileAccess,
        },
        Effect.fnUntraced(function* (claim) {
          if (!(yield* isOwnerOnlyRecordFile(recordPath, options.privateFileAccess))) {
            yield* changeWorkerClaim(
              claim,
              "reap-stale",
              Effect.promise(() => rm(runDir, { recursive: true, force: true })),
            );
            return;
          }
          const record = yield* readWorkerRecordAt(recordPath);
          if (record === undefined) {
            const legacyRecord = yield* readLegacyWorkerRecordAt(recordPath);
            if (legacyRecord === undefined) return;
            const state = yield* readWorkerRecordStateAt(recordPath);
            if (state._tag !== "legacy" || state.appRoot === null) return;
            const legacyDir =
              state.appRoot === undefined
                ? resolve(paths.hostProxyRunRoot, sanitizeAppName(legacyRecord.appId))
                : resolve(paths.hostProxyRunDir(legacyRecord.appId, state.appRoot));
            if (legacyDir !== runDir) return;
            yield* terminateControlRecord(
              legacyRecord,
              { ...options, claim },
              Effect.promise(() => rm(legacyDir, { recursive: true, force: true })),
            );
            return;
          }
          if (resolve(paths.hostProxyRunDir(record.appId, record.appRoot)) !== runDir) return;
          yield* terminateControlRecord(
            record,
            { ...options, claim },
            Effect.promise(() => rm(runDir, { recursive: true, force: true })),
          );
        }),
      ).pipe(Effect.catch(() => Effect.void));
    }
  },
  Effect.catch(() => Effect.void),
);
