import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Effect, Schema } from "effect";

import { HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import type { AppRef } from "@lando/sdk/schema";

import type { RootOverrides } from "../../config/paths.ts";
import { writeFileAtomicScoped } from "../../state-store/atomic.ts";
import { withAdvisoryLock } from "../../state/lock.ts";
import { hostProxyRunLandoStateDir } from "./transport.ts";
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
