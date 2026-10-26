import { readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Effect } from "effect";

import type { AppRef } from "@lando/sdk/schema";

import type { RootOverrides } from "@lando/paths";
import { makeLandoPaths, sanitizeAppName } from "@lando/paths";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { isOwnerOnlyRecordFile, withDetachedWorkerLock } from "../detached-worker/state-file.ts";
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

const removeRunDir = (app: Pick<AppRef, "id" | "root">, paths?: RootOverrides): Effect.Effect<void> =>
  Effect.promise(() => rm(dirname(workerStatePath(app, paths)), { recursive: true, force: true }));

export const replaceExistingHostProxyWorker = (
  app: Pick<AppRef, "id" | "root">,
  options: TerminateHostProxyWorkerOptions,
) =>
  readWorkerRecordStateAt(workerStatePath(app, options.paths)).pipe(
    Effect.flatMap(
      Effect.fnUntraced(function* (state) {
        if (!(yield* isOwnerOnlyRecordFile(workerStatePath(app, options.paths), options.privateFileAccess)))
          return yield* removeRunDir(app, options.paths);
        if (state._tag === "absent" || state._tag === "malformed")
          return yield* removeRunDir(app, options.paths);
        const root = state._tag === "current" ? state.record.appRoot : state.appRoot;
        if (state.record.appId !== app.id || (root !== undefined && root !== app.root))
          return yield* removeRunDir(app, options.paths);
        return yield* terminateControlRecord(state.record, options, removeRunDir(app, options.paths));
      }),
    ),
  );

export const terminateOwnedHostProxyWorker = (
  app: Pick<AppRef, "id" | "root">,
  options: TerminateHostProxyWorkerOptions,
) =>
  withWorkerRecordLock(
    app,
    options.paths,
    isOwnerOnlyRecordFile(workerStatePath(app, options.paths), options.privateFileAccess).pipe(
      Effect.flatMap((trusted) =>
        trusted
          ? readWorkerRecordStateAt(workerStatePath(app, options.paths))
          : Effect.succeed({ _tag: "malformed" as const }),
      ),
      Effect.flatMap((state): Effect.Effect<TerminateOwnershipResult> => {
        if (state._tag === "absent" || state._tag === "malformed")
          return removeRunDir(app, options.paths).pipe(Effect.as("absent" as const));
        const root = state._tag === "current" ? state.record.appRoot : state.appRoot;
        if (state.record.appId !== app.id || (root !== undefined && root !== app.root))
          return removeRunDir(app, options.paths).pipe(Effect.as("absent" as const));
        return terminateControlRecord(state.record, options, removeRunDir(app, options.paths)).pipe(
          Effect.as("terminated" as const),
          Effect.catch(() => Effect.succeed("absent" as const)),
        );
      }),
    ),
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
        Effect.gen(function* () {
          if (!(yield* isOwnerOnlyRecordFile(recordPath, options.privateFileAccess))) {
            yield* Effect.promise(() => rm(runDir, { recursive: true, force: true }));
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
              options,
              Effect.promise(() => rm(legacyDir, { recursive: true, force: true })),
            );
            return;
          }
          if (resolve(paths.hostProxyRunDir(record.appId, record.appRoot)) !== runDir) return;
          yield* terminateControlRecord(
            record,
            options,
            Effect.promise(() => rm(runDir, { recursive: true, force: true })),
          );
        }),
      ).pipe(Effect.catch(() => Effect.void));
    }
  },
  Effect.catch(() => Effect.void),
);
