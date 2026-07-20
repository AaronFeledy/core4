import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Effect, Either, Schema } from "effect";

import { HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import type { AppRef } from "@lando/sdk/schema";

import type { RootOverrides } from "../../config/paths.ts";
import { writeFileAtomicScoped } from "../../state-store/atomic.ts";
import { withAdvisoryLock } from "../../state/lock.ts";
import { hostProxyRunLandoStateDir } from "./transport-session.ts";
import { HostProxyWorkerRecord, LegacyHostProxyWorkerRecord } from "./worker-records.ts";

export const workerStatePath = (app: Pick<AppRef, "id" | "root">, paths?: RootOverrides): string =>
  resolve(hostProxyRunLandoStateDir(app, paths), "worker.json");

const stateError = (message: string, path: string, cause?: unknown): HostProxyTransportUnavailableError =>
  new HostProxyTransportUnavailableError({
    message,
    socketPath: path,
    remediation: "Inspect or remove the host-proxy worker state directory, then retry.",
    ...(cause === undefined ? {} : { cause }),
  });

export type HostProxyWorkerRecordState =
  | { readonly _tag: "absent" }
  | { readonly _tag: "current"; readonly record: HostProxyWorkerRecord }
  | { readonly _tag: "legacy"; readonly record: LegacyHostProxyWorkerRecord }
  | { readonly _tag: "malformed" };

const CURRENT_WORKER_RECORD_KEYS = ["appRoot", "providerId", "containerUrl", "probeServices"] as const;

export const readWorkerRecordStateAt = (path: string): Effect.Effect<HostProxyWorkerRecordState> =>
  Effect.promise(async () => {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) return { _tag: "absent" };
      const value = await file.json();
      const current = Schema.decodeUnknownEither(HostProxyWorkerRecord)(value);
      if (Either.isRight(current)) return { _tag: "current", record: current.right };
      if (
        typeof value === "object" &&
        value !== null &&
        CURRENT_WORKER_RECORD_KEYS.some((key) => Object.hasOwn(value, key))
      )
        return { _tag: "malformed" };
      const legacy = Schema.decodeUnknownEither(LegacyHostProxyWorkerRecord)(value);
      return Either.isRight(legacy) ? { _tag: "legacy", record: legacy.right } : { _tag: "malformed" };
    } catch {
      return { _tag: "malformed" };
    }
  });

export const readWorkerRecord = (app: Pick<AppRef, "id" | "root">, paths?: RootOverrides) =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(workerStatePath(app, paths));
      if (!(await file.exists())) return undefined;
      return Schema.decodeUnknownSync(HostProxyWorkerRecord)(await file.json());
    },
    catch: (cause) =>
      stateError("Failed to read host-proxy worker state.", workerStatePath(app, paths), cause),
  });

export const readWorkerRecordAt = (path: string): Effect.Effect<HostProxyWorkerRecord | undefined, never> =>
  Effect.promise(async () => {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) return undefined;
      return Schema.decodeUnknownSync(HostProxyWorkerRecord)(await file.json());
    } catch {
      return undefined;
    }
  });

export const readLegacyWorkerRecordAt = (
  path: string,
): Effect.Effect<LegacyHostProxyWorkerRecord | undefined, never> =>
  Effect.promise(async () => {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) return undefined;
      return Schema.decodeUnknownSync(LegacyHostProxyWorkerRecord)(await file.json());
    } catch {
      return undefined;
    }
  });

export const writeWorkerRecord = (
  app: AppRef,
  paths: RootOverrides | undefined,
  record: HostProxyWorkerRecord,
) => {
  const path = workerStatePath(app, paths);
  return Effect.tryPromise({
    try: () => mkdir(dirname(path), { recursive: true, mode: 0o700 }).then(() => undefined),
    catch: (cause) => stateError("Failed to create host-proxy worker state directory.", path, cause),
  }).pipe(
    Effect.zipRight(
      writeFileAtomicScoped(
        path,
        `${JSON.stringify(Schema.encodeUnknownSync(HostProxyWorkerRecord)(record), null, 2)}\n`,
        {
          mode: 0o600,
        },
      ).pipe(Effect.mapError((cause) => stateError("Failed to write host-proxy worker state.", path, cause))),
    ),
  );
};

export const withWorkerRecordLock = <A, E>(
  app: Pick<AppRef, "id" | "root">,
  paths: RootOverrides | undefined,
  body: Effect.Effect<A, E>,
) => withAdvisoryLock(workerStatePath(app, paths), "host-proxy-worker", body);
