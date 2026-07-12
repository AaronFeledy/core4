import { readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Effect } from "effect";

import { AbsolutePath, type AppRef } from "@lando/sdk/schema";

import type { RootOverrides } from "../../config/paths.ts";
import { makeLandoPaths, sanitizeAppName } from "../../config/paths.ts";
import { withAdvisoryLock } from "../../state/lock.ts";
import { terminateControlRecord } from "./worker-control.ts";
import {
  readLegacyWorkerRecordAt,
  readWorkerRecord,
  readWorkerRecordAt,
  withWorkerRecordLock,
  workerStatePath,
} from "./worker-state-file.ts";

export interface TerminateHostProxyWorkerOptions {
  readonly paths?: RootOverrides;
  readonly terminateProcess?: (pid: number, signal: NodeJS.Signals) => Promise<void>;
}

export type TerminateOwnershipResult = "terminated" | "absent";

const removeRunDir = (app: Pick<AppRef, "id" | "root">, paths?: RootOverrides): Effect.Effect<void> =>
  Effect.promise(() => rm(dirname(workerStatePath(app, paths)), { recursive: true, force: true }));

const removeRecordDir = (path: string): Effect.Effect<void> =>
  Effect.promise(() => rm(path, { recursive: true, force: true }));

export const replaceExistingHostProxyWorker = (
  app: Pick<AppRef, "id" | "root">,
  options: TerminateHostProxyWorkerOptions = {},
) =>
  readWorkerRecord(app, options.paths).pipe(
    Effect.flatMap((record) => {
      if (record === undefined) return removeRunDir(app, options.paths);
      return terminateControlRecord(record, options, removeRunDir(app, options.paths));
    }),
  );

export const terminateOwnedHostProxyWorker = (
  app: Pick<AppRef, "id" | "root">,
  options: TerminateHostProxyWorkerOptions = {},
) =>
  withWorkerRecordLock(
    app,
    options.paths,
    readWorkerRecord(app, options.paths).pipe(
      Effect.flatMap((record): Effect.Effect<TerminateOwnershipResult> => {
        if (record === undefined) return removeRunDir(app, options.paths).pipe(Effect.as("absent" as const));
        return replaceExistingHostProxyWorker(app, options).pipe(
          Effect.as("terminated" as const),
          Effect.catchAll(() => Effect.succeed("absent" as const)),
        );
      }),
    ),
  ).pipe(Effect.catchAll(() => Effect.succeed("absent" as const)));

export const removeOwnedHostProxyWorkerState = (
  app: Pick<AppRef, "id" | "root">,
  paths?: RootOverrides,
  options: Omit<TerminateHostProxyWorkerOptions, "paths"> = {},
): Effect.Effect<void, never> =>
  terminateOwnedHostProxyWorker(app, { ...options, ...(paths === undefined ? {} : { paths }) }).pipe(
    Effect.asVoid,
    Effect.catchAll(() => Effect.void),
  );

export const terminateOwnedHostProxyWorkersInRoot = (
  userDataRoot: string,
  options: Omit<TerminateHostProxyWorkerOptions, "paths"> = {},
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const paths = makeLandoPaths({ userDataRoot });
    const entries = yield* Effect.promise(() =>
      readdir(paths.hostProxyRunRoot, { withFileTypes: true }).catch(() => []),
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const recordPath = resolve(paths.hostProxyRunRoot, entry.name, "worker.json");
      const record = yield* readWorkerRecordAt(recordPath);
      if (record === undefined) {
        const legacyRecord = yield* readLegacyWorkerRecordAt(recordPath);
        if (legacyRecord === undefined) continue;
        const legacyDir = resolve(paths.hostProxyRunRoot, sanitizeAppName(legacyRecord.appId));
        if (legacyDir !== resolve(paths.hostProxyRunRoot, entry.name)) continue;
        yield* withAdvisoryLock(
          recordPath,
          "host-proxy-worker",
          terminateControlRecord(legacyRecord, options, removeRecordDir(legacyDir)),
        ).pipe(Effect.catchAll(() => Effect.void));
        continue;
      }
      if (
        resolve(paths.hostProxyRunDir(record.appId, record.appRoot)) !==
        resolve(paths.hostProxyRunRoot, entry.name)
      )
        continue;
      const app = { id: record.appId, root: AbsolutePath.make(record.appRoot) };
      yield* terminateOwnedHostProxyWorker(app, { ...options, paths: { userDataRoot } }).pipe(Effect.asVoid);
    }
  }).pipe(Effect.catchAll(() => Effect.void));
