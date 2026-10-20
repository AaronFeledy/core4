import { lstat, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { RedactionService } from "@lando/redaction/service";
import { Effect, Option } from "effect";
import { isOwnerOnlyRecordFile } from "../detached-worker/state-file.ts";
import type { DetachedHostProxyWorkerOptions } from "./detached-worker.ts";
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
  if (record.transport === "unix-socket") {
    const privateSocket = yield* Effect.tryPromise(async () => {
      if (record.socketPath === undefined) return false;
      const metadata = await lstat(record.socketPath);
      return metadata.isSocket() && (metadata.mode & 0o077) === 0 && metadata.uid === process.getuid?.();
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!privateSocket) return undefined;
  }
  if ((yield* probeWorker(record, { requireSessionIdentity: true })) !== "live") return undefined;
  if (!(yield* configureWorker(record, options.plan))) return undefined;
  const closed = Promise.withResolvers<void>();
  let closePromise: Promise<void> | undefined;
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
    closed: closed.promise,
    close: () => {
      if (options.reusePolicy === "adopt") return Promise.resolve();
      closePromise ??= Effect.runPromise(
        withWorkerRecordLock(
          options.app,
          options.paths,
          Effect.gen(function* () {
            const current = yield* readWorkerRecord(options.app, options.paths);
            if (current?.sessionId !== record.sessionId) return;
            if (
              !(yield* isOwnerOnlyRecordFile(
                workerStatePath(options.app, options.paths),
                options.privateFileAccess,
              ))
            ) {
              yield* Effect.promise(() =>
                rm(dirname(workerStatePath(options.app, options.paths)), { recursive: true, force: true }),
              );
              return;
            }
            yield* terminateControlRecord(
              record,
              options,
              Effect.promise(() =>
                rm(dirname(workerStatePath(options.app, options.paths)), { recursive: true, force: true }),
              ),
            );
          }),
          options.privateFileAccess,
        ),
      ).finally(closed.resolve);
      return closePromise;
    },
  };
});
