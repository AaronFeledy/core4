import { resolve } from "node:path";

import { Effect, Result, Schema } from "effect";

import { HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import type { AppRef } from "@lando/sdk/schema";

import type { RootOverrides } from "@lando/paths";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import {
  readDetachedWorkerRecord,
  withDetachedWorkerLock,
  writeDetachedWorkerRecord,
} from "../detached-worker/state-file.ts";
import { hostProxyRunLandoStateDir } from "./transport-session.ts";
import { HostProxyWorkerRecord, LegacyHostProxyWorkerRecord } from "./worker-records.ts";

export const workerStatePath = (app: Pick<AppRef, "id" | "root">, paths?: RootOverrides): string =>
  resolve(hostProxyRunLandoStateDir(app, paths), "worker.json");

const stateError = (message: string, path: string): HostProxyTransportUnavailableError =>
  new HostProxyTransportUnavailableError({
    message,
    socketPath: path,
    remediation: "Inspect or remove the host-proxy worker state directory, then retry.",
  });

export type HostProxyWorkerRecordState =
  | { readonly _tag: "absent" }
  | { readonly _tag: "current"; readonly record: HostProxyWorkerRecord }
  | {
      readonly _tag: "legacy";
      readonly record: LegacyHostProxyWorkerRecord;
      readonly appRoot: string | null | undefined;
    }
  | { readonly _tag: "malformed" };

export const readWorkerRecordStateAt = (path: string): Effect.Effect<HostProxyWorkerRecordState> =>
  Effect.promise(async () => {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) return { _tag: "absent" };
      const value = await file.json();
      const current = Schema.decodeUnknownResult(HostProxyWorkerRecord)(value);
      if (Result.isSuccess(current)) return { _tag: "current", record: current.success };
      const legacy = Schema.decodeUnknownResult(LegacyHostProxyWorkerRecord)(value);
      if (Result.isFailure(legacy)) return { _tag: "malformed" };
      const appRoot =
        typeof value === "object" && value !== null && "appRoot" in value
          ? typeof value.appRoot === "string"
            ? value.appRoot
            : null
          : undefined;
      return { _tag: "legacy", record: legacy.success, appRoot };
    } catch {
      return { _tag: "malformed" };
    }
  });

export const readWorkerRecord = (app: Pick<AppRef, "id" | "root">, paths?: RootOverrides) =>
  readWorkerRecordAt(workerStatePath(app, paths));

export const readWorkerRecordAt = (path: string): Effect.Effect<HostProxyWorkerRecord | undefined, never> =>
  readDetachedWorkerRecord(path, HostProxyWorkerRecord).pipe(Effect.catch(() => Effect.succeed(undefined)));

export const readLegacyWorkerRecordAt = (
  path: string,
): Effect.Effect<LegacyHostProxyWorkerRecord | undefined, never> =>
  readDetachedWorkerRecord(path, LegacyHostProxyWorkerRecord).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );

export const writeWorkerRecord = (
  app: AppRef,
  paths: RootOverrides | undefined,
  record: HostProxyWorkerRecord,
  privateFileAccess: PrivateFileAccess,
) => {
  const path = workerStatePath(app, paths);
  return writeDetachedWorkerRecord({ path, schema: HostProxyWorkerRecord, privateFileAccess }, record).pipe(
    Effect.mapError(() => stateError("Failed to write host-proxy worker state.", path)),
  );
};

export const withWorkerRecordLock = <A, E>(
  app: Pick<AppRef, "id" | "root">,
  paths: RootOverrides | undefined,
  body: Effect.Effect<A, E>,
  privateFileAccess: PrivateFileAccess,
) =>
  withDetachedWorkerLock(
    { path: workerStatePath(app, paths), label: "host-proxy-worker", paths, privateFileAccess },
    body,
  );
