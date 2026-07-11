import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
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
import {
  type HostProxyShimTarget,
  defaultHostProxyShimArtifactPath,
  installHostProxyShim,
} from "./transport-shim.ts";

export {
  HOST_PROXY_CONTAINER_LANDO,
  HOST_PROXY_CONTAINER_SHIM,
  HOST_PROXY_CONTAINER_SOCKET,
  HOST_PROXY_RUN_LANDO_ENV_NAMES,
  HOST_PROXY_TRANSPORT_EXTENSION_KEY,
  hostProxyRunLandoFeature,
  isHostProxyRunLandoEnvName,
  stripHostProxyRunLando,
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
const DEFAULT_BODY_READ_TIMEOUT_MS = 30_000;

export type HostProxyTransportKind = "unix-socket" | "tcp-host-gateway";

export interface HostProxyRunLandoSessionOptions {
  readonly app: AppRef;
  readonly mountInfo: HostProxyMountInfo;
  readonly allowlist: ReadonlyArray<string>;
  readonly callerService: string;
  readonly executor: HostProxyRunLandoExecutor;
  readonly paths?: RootOverrides;
  readonly concurrency?: number;
  readonly maxDepth?: number;
  readonly bodyReadTimeoutMs?: number;
  readonly shimArtifactPath?: string;
  readonly shimTarget?: HostProxyShimTarget;
  readonly hostGatewayName?: string;
  readonly controlToken?: string;
}

export interface HostProxyRunLandoSession {
  readonly appId: string;
  readonly sessionId: string;
  readonly token: string;
  readonly controlToken: string;
  readonly socketPath?: string;
  readonly url?: string;
  readonly containerUrl?: string;
  readonly shimPath: string;
  readonly transport: HostProxyTransportKind;
  readonly close: () => Promise<void>;
  readonly closed: Promise<void>;
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

export const hostProxyRunLandoStateDir = (app: Pick<AppRef, "id">, paths?: RootOverrides): string => {
  const landoPaths = makeLandoPaths(paths ?? {});
  return landoPaths.hostProxyRunDir(app.id);
};

const sessionPaths = (options: HostProxyRunLandoSessionOptions) => {
  const paths = makeLandoPaths(options.paths ?? {});
  const base = hostProxyRunLandoStateDir(options.app, options.paths);
  const transport: HostProxyTransportKind = paths.platform === "win32" ? "tcp-host-gateway" : "unix-socket";
  return {
    stateDir: base,
    socketPath: transport === "unix-socket" ? resolve(base, "host-proxy.sock") : undefined,
    shimPath: resolve(base, paths.platform === "win32" ? "lando.exe" : "lando"),
    platform: paths.platform,
    transport,
  };
};

export const cleanupHostProxyRunLandoState = (
  app: AppRef,
  paths?: RootOverrides,
): Effect.Effect<void, never> =>
  Effect.promise(async () => {
    const { removeHostProxyWorkerState } = await import("./worker.ts");
    await Effect.runPromise(removeHostProxyWorkerState(app, paths));
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
  let closePromise: Promise<void> | undefined;
  let url: string | undefined;
  let containerUrl: string | undefined;
  return Effect.gen(function* () {
    const runtimeContext = yield* Effect.context<EventService | RedactionService>();
    const sessionId = makeToken();
    const token = makeToken();
    const controlToken = options.controlToken ?? makeToken();
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const bodyReadTimeoutMs = options.bodyReadTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS;
    const shimArtifact =
      options.shimArtifactPath ??
      (options.shimTarget === undefined
        ? undefined
        : defaultHostProxyShimArtifactPath({ target: options.shimTarget }));
    if (shimArtifact === undefined) {
      return yield* Effect.fail(
        new HostProxyTransportUnavailableError({
          message: "Host-proxy session creation requires an explicit shim artifact or container target.",
          socketPath: "host-proxy-shim-target",
          remediation: "Resolve the host-proxy eligible container target before starting the session.",
        }),
      );
    }
    const semaphore = Effect.unsafeMakeSemaphore(concurrency);
    const inFlight = new Set<HostProxyInFlightRequest>();
    const shutdownRef: { current?: () => Promise<void> } = {};

    yield* installHostProxyShim(shimArtifact, paths.shimPath);
    yield* Effect.tryPromise({
      try: () => mkdir(paths.stateDir, { recursive: true }),
      catch: (cause) =>
        new HostProxyTransportUnavailableError({
          message: cause instanceof Error ? cause.message : String(cause),
          socketPath: paths.socketPath ?? paths.stateDir,
          remediation: "Ensure the app cache directory is writable.",
        }),
    });
    const session = { appId: options.app.id, sessionId, token, controlToken };
    const server = createServer(
      makeHostProxyRunLandoHandler({
        ...options,
        session,
        control: {
          token: controlToken,
          transport: paths.transport,
          protocolVersion: 1,
          pid: process.pid,
          shutdown: () => shutdownRef.current?.() ?? Promise.resolve(),
        },
        concurrency,
        maxDepth,
        bodyReadTimeoutMs,
        semaphore,
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
        resume(Effect.fail(listenFailure(cause, paths.socketPath ?? paths.stateDir)));
      });
      const completeListen = () => {
        restoreUmask();
        if (settled) return;
        settled = true;
        socketOwned = true;
        if (paths.transport === "tcp-host-gateway") {
          const address = server.address() as AddressInfo | null;
          if (address === null) {
            resume(
              Effect.fail(
                new HostProxyTransportUnavailableError({
                  message: "Host-proxy TCP bridge did not report a listening address.",
                  socketPath: paths.stateDir,
                  remediation: "Restart the app so Lando can recreate the host-proxy bridge.",
                }),
              ),
            );
            return;
          }
          url = `http://127.0.0.1:${address.port}`;
          containerUrl = `http://${options.hostGatewayName ?? "host.containers.internal"}:${address.port}`;
        }
        const secureSocket =
          paths.transport === "unix-socket" && paths.socketPath !== undefined
            ? chmod(paths.socketPath, 0o600)
            : Promise.resolve();
        void secureSocket.then(
          () => resume(Effect.void),
          (cause) => {
            server.close(() => {
              resume(
                Effect.fail(
                  new HostProxyTransportUnavailableError({
                    message: cause instanceof Error ? cause.message : String(cause),
                    socketPath: paths.socketPath ?? url ?? paths.stateDir,
                    remediation: "Ensure the app run directory is writable.",
                  }),
                ),
              );
            });
          },
        );
      };
      if (paths.transport === "tcp-host-gateway") {
        server.listen(0, "127.0.0.1", completeListen);
      } else if (paths.socketPath !== undefined) {
        server.listen(paths.socketPath, completeListen);
      }
    });

    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolveClosedPromise) => {
      resolveClosed = resolveClosedPromise;
    });
    const close = async () => {
      closePromise ??= (async () => {
        const requests = [...inFlight];
        const serverClosed = new Promise<void>((resolveClose, rejectClose) =>
          server.close((cause) => (cause === undefined ? resolveClose() : rejectClose(cause))),
        );
        for (const request of requests) request.response.destroy();
        await Effect.runPromise(Fiber.interruptAll(requests.map(({ fiber }) => fiber)));
        server.closeAllConnections();
        await serverClosed;
        await rm(paths.stateDir, { recursive: true, force: true });
      })().finally(resolveClosed);
      await closePromise;
    };
    shutdownRef.current = close;

    return {
      ...session,
      ...(paths.socketPath === undefined ? {} : { socketPath: paths.socketPath }),
      ...(url === undefined ? {} : { url }),
      ...(containerUrl === undefined ? {} : { containerUrl }),
      shimPath: paths.shimPath,
      transport: paths.transport,
      close,
      closed,
    };
  }).pipe(
    Effect.catchAll((failure) =>
      Effect.promise(async () => {
        await rm(paths.stateDir, { recursive: true, force: true });
        if (socketOwned && paths.transport === "unix-socket" && paths.socketPath !== undefined)
          await rm(paths.socketPath, { force: true });
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
