import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { Effect, Fiber, type Scope } from "effect";

import { HostProxySocketStaleError, HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import type { AppRef } from "@lando/sdk/schema";
import type { EventService } from "@lando/sdk/services";

import type { RootOverrides } from "../../config/paths.ts";
import { makeLandoPaths } from "../../config/paths.ts";
import type { RedactionService } from "../../redaction/service.ts";
import type { HostProxyMountInfo } from "./cwd-remap.ts";
import type { HostProxyRunLandoExecutor } from "./dispatch.ts";
import { type HostProxyInFlightRequest, makeHostProxyRunLandoHandler } from "./transport-handler.ts";
import { defaultHostProxyShimArtifactPath, installHostProxyShim } from "./transport-shim.ts";

export {
  HOST_PROXY_CONTAINER_SHIM,
  HOST_PROXY_CONTAINER_SOCKET,
  hostProxyRunLandoFeature,
} from "./transport-feature.ts";
export { connectHostProxyRunLando, sendHostProxyRunLando } from "./transport-protocol.ts";
export type { HostProxyRunLandoClientRequest, HostProxyTransportError } from "./transport-protocol.ts";
export {
  HOST_PROXY_SHIM_ARTIFACT,
  HOST_PROXY_SHIM_ARTIFACT_ENV,
  HOST_PROXY_SHIM_SOURCE,
} from "./transport-shim.ts";

const DEFAULT_CONCURRENCY = 16;
const DEFAULT_MAX_DEPTH = 3;

export interface HostProxyRunLandoSessionOptions {
  readonly app: AppRef;
  readonly mountInfo: HostProxyMountInfo;
  readonly allowlist: ReadonlyArray<string>;
  readonly callerService: string;
  readonly executor: HostProxyRunLandoExecutor;
  readonly paths?: RootOverrides;
  readonly concurrency?: number;
  readonly maxDepth?: number;
  readonly shimArtifactPath?: string;
}

export interface HostProxyRunLandoSession {
  readonly appId: string;
  readonly sessionId: string;
  readonly token: string;
  readonly socketPath: string;
  readonly shimPath: string;
  readonly close: () => Promise<void>;
}

const makeToken = (): string => randomBytes(32).toString("base64url");

const hasErrorCode = (cause: Error): cause is Error & { readonly code: unknown } => "code" in cause;

const listenFailure = (
  cause: Error,
  socketPath: string,
): HostProxySocketStaleError | HostProxyTransportUnavailableError => {
  const code = hasErrorCode(cause) && typeof cause.code === "string" ? cause.code : "";
  if (code === "EADDRINUSE") {
    return new HostProxySocketStaleError({
      message: `Host-proxy socket already exists at ${socketPath}.`,
      socketPath,
      remediation: "Run `lando app:cache:refresh` or `lando apps:poweroff`, then start the app again.",
    });
  }
  return new HostProxyTransportUnavailableError({
    message: cause.message,
    socketPath,
    remediation: "Ensure no other host-proxy session owns this app socket.",
  });
};

export const hostProxyRunLandoStateDir = (app: AppRef, paths?: RootOverrides): string => {
  const landoPaths = makeLandoPaths(paths ?? {});
  return landoPaths.hostProxyRunDir(app.id);
};

const sessionPaths = (options: HostProxyRunLandoSessionOptions) => {
  const paths = makeLandoPaths(options.paths ?? {});
  const base = hostProxyRunLandoStateDir(options.app, options.paths);
  return {
    socketPath: resolve(base, "host-proxy.sock"),
    shimPath: resolve(base, "lando"),
    platform: paths.platform,
  };
};

export const cleanupHostProxyRunLandoState = (
  app: AppRef,
  paths?: RootOverrides,
): Effect.Effect<void, never> =>
  Effect.promise(async () => {
    const { terminateOwnedHostProxyWorker } = await import("./worker.ts");
    await Effect.runPromise(terminateOwnedHostProxyWorker(app, paths === undefined ? {} : { paths }));
    await rm(hostProxyRunLandoStateDir(app, paths), { recursive: true, force: true });
  }).pipe(Effect.catchAll(() => Effect.void));

export const createHostProxyRunLandoSession = (
  options: HostProxyRunLandoSessionOptions,
): Effect.Effect<
  HostProxyRunLandoSession,
  HostProxySocketStaleError | HostProxyTransportUnavailableError,
  EventService | RedactionService
> => {
  const paths = sessionPaths(options);
  let socketOwned = false;
  return Effect.gen(function* () {
    const runtimeContext = yield* Effect.context<EventService | RedactionService>();
    if (paths.platform === "win32") {
      return yield* Effect.fail(
        new HostProxyTransportUnavailableError({
          message: "Host-proxy runLando requires Unix socket support and is not available on Windows hosts.",
          socketPath: paths.socketPath,
          remediation: "Run host-proxy enabled apps from a Linux or macOS host.",
        }),
      );
    }
    const sessionId = makeToken();
    const token = makeToken();
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const shimArtifact = options.shimArtifactPath ?? defaultHostProxyShimArtifactPath();
    const active = { value: 0 };
    const inFlight = new Set<HostProxyInFlightRequest>();

    yield* installHostProxyShim(shimArtifact, paths.shimPath);
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(paths.socketPath), { recursive: true }),
      catch: (cause) =>
        new HostProxyTransportUnavailableError({
          message: cause instanceof Error ? cause.message : String(cause),
          socketPath: paths.socketPath,
          remediation: "Ensure the app cache directory is writable.",
        }),
    });
    const session = { appId: options.app.id, sessionId, token };
    const server = createServer(
      makeHostProxyRunLandoHandler({
        ...options,
        session,
        concurrency,
        maxDepth,
        active,
        inFlight,
        runtimeContext,
      }),
    );

    yield* Effect.async<void, HostProxySocketStaleError | HostProxyTransportUnavailableError>((resume) => {
      let settled = false;
      const previousUmask = process.umask(0o177);
      const restoreUmask = (): void => {
        process.umask(previousUmask);
      };
      server.once("error", (cause) => {
        if (settled) return;
        restoreUmask();
        settled = true;
        resume(Effect.fail(listenFailure(cause, paths.socketPath)));
      });
      server.listen(paths.socketPath, () => {
        restoreUmask();
        if (settled) return;
        settled = true;
        socketOwned = true;
        void chmod(paths.socketPath, 0o600).then(
          () => resume(Effect.void),
          (cause) => {
            server.close(() => {
              resume(
                Effect.fail(
                  new HostProxyTransportUnavailableError({
                    message: cause instanceof Error ? cause.message : String(cause),
                    socketPath: paths.socketPath,
                    remediation: "Ensure the app run directory is writable.",
                  }),
                ),
              );
            });
          },
        );
      });
    });

    return {
      ...session,
      socketPath: paths.socketPath,
      shimPath: paths.shimPath,
      close: async () => {
        const requests = [...inFlight];
        const serverClosed = new Promise<void>((resolveClose, rejectClose) =>
          server.close((cause) => (cause === undefined ? resolveClose() : rejectClose(cause))),
        );
        for (const request of requests) request.response.destroy();
        await Effect.runPromise(Fiber.interruptAll(requests.map(({ fiber }) => fiber)));
        server.closeAllConnections();
        await serverClosed;
        await rm(dirname(paths.socketPath), { recursive: true, force: true });
      },
    };
  }).pipe(
    Effect.catchAll((failure) =>
      Effect.promise(async () => {
        await rm(paths.shimPath, { force: true });
        if (socketOwned) await rm(paths.socketPath, { force: true });
      }).pipe(
        Effect.catchAll(() => Effect.void),
        Effect.zipRight(Effect.fail(failure)),
      ),
    ),
  );
};

export const scopedHostProxyRunLandoSession = (
  options: HostProxyRunLandoSessionOptions,
): Effect.Effect<
  HostProxyRunLandoSession,
  HostProxySocketStaleError | HostProxyTransportUnavailableError,
  EventService | RedactionService | Scope.Scope
> =>
  Effect.acquireRelease(createHostProxyRunLandoSession(options), (session) =>
    Effect.promise(() => session.close()),
  );
