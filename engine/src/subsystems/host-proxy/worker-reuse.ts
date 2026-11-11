import { lstat, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { RedactionService } from "@lando/redaction/service";
import { Effect, Option } from "effect";
import { changeWorkerClaim } from "../detached-worker/claim.ts";
import { workerSessionLifetime } from "../detached-worker/lifecycle.ts";
import { isOwnerOnlyRecordFile } from "../detached-worker/state-file.ts";
import type { DetachedHostProxyWorkerOptions } from "./detached-worker.ts";
import { verifyHostProxyRunDirectory } from "./run-directory.ts";
import type { HostProxyRunLandoSession } from "./transport-session.ts";
import { configureWorker, probeWorker, terminateControlRecord } from "./worker-control.ts";
import { HOST_PROXY_WORKER_PROTOCOL_VERSION } from "./worker-records.ts";
import { readWorkerRecord, withWorkerRecordLock, workerStatePath } from "./worker-state-file.ts";

export const registerHostProxyCredentials = Effect.fnUntraced(function* (credentials: {
  readonly sessionId: string;
  readonly token: string;
  readonly controlToken: string;
}) {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (Option.isSome(redaction))
    yield* redaction.value.registerValues([
      credentials.sessionId,
      credentials.token,
      credentials.controlToken,
    ]);
});

export const reuseHostProxyWorker = Effect.fnUntraced(function* (
  options: DetachedHostProxyWorkerOptions,
  configDigest: string,
): Effect.fn.Return<(HostProxyRunLandoSession & { readonly reused: true }) | undefined> {
  const record = yield* readWorkerRecord(options.app, options.paths);
  if (record === undefined) return undefined;
  yield* registerHostProxyCredentials(record);
  if (
    record.appId !== options.app.id ||
    record.appRoot !== options.app.root ||
    record.providerId !== options.plan.provider ||
    record.protocolVersion !== HOST_PROXY_WORKER_PROTOCOL_VERSION ||
    (options.reusePolicy !== "adopt" && record.configDigest !== configDigest)
  )
    return undefined;
  const privateRecord = yield* isOwnerOnlyRecordFile(
    workerStatePath(options.app, options.paths),
    options.privateFileAccess,
  );
  if (!privateRecord || !(yield* Effect.promise(() => Bun.file(record.shimPath).exists()))) return undefined;
  if (record.transport === "unix-socket" && record.url === undefined) {
    const privateSocket = yield* Effect.tryPromise(async () => {
      if (record.socketPath === undefined) return false;
      await verifyHostProxyRunDirectory(dirname(record.socketPath));
      const metadata = await lstat(record.socketPath);
      return metadata.isSocket() && metadata.uid === process.getuid?.();
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!privateSocket) return undefined;
  }
  if ((yield* probeWorker(record, { requireSessionIdentity: true })) !== "live") return undefined;
  if (!(yield* configureWorker(record, options.plan))) return undefined;
  const lifetime = workerSessionLifetime(() =>
    Effect.runPromise(
      withWorkerRecordLock(
        options.app,
        options.paths,
        Effect.fnUntraced(function* (claim) {
          const current = yield* readWorkerRecord(options.app, options.paths);
          if (current?.sessionId !== record.sessionId) return;
          const removeRunDir = Effect.promise(() =>
            rm(dirname(claim.path), { recursive: true, force: true }),
          );
          if (!(yield* isOwnerOnlyRecordFile(claim.path, options.privateFileAccess))) {
            yield* changeWorkerClaim(claim, "reap-stale", removeRunDir);
            return;
          }
          yield* terminateControlRecord(record, { ...options, claim }, removeRunDir);
        }),
        options.privateFileAccess,
      ),
    ),
  );
  return {
    appId: record.appId,
    sessionId: record.sessionId,
    token: record.token,
    controlToken: record.controlToken,
    transport: record.transport,
    shimPath: record.shimPath,
    ...(record.socketPath === undefined ? {} : { socketPath: record.socketPath }),
    ...(record.url === undefined ? {} : { url: record.url }),
    ...(record.containerUrl === undefined ? {} : { containerUrl: record.containerUrl }),
    reused: true,
    ...lifetime,
    ...(options.reusePolicy === "adopt" ? { close: () => Promise.resolve() } : {}),
  };
});
