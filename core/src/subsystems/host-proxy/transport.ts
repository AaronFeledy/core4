import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { Effect, type Scope } from "effect";

import { type HostProxySocketStaleError, HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import type { EventService } from "@lando/sdk/services";

import type { RedactionService } from "../../redaction/service.ts";
import { type HostProxyInFlightRequest, makeHostProxyRunLandoHandler } from "./transport-handler.ts";
import { closeHostProxyServer, removeSessionState } from "./transport-lifecycle.ts";
import { listenHostProxyServer } from "./transport-listener.ts";
import {
  DEFAULT_BODY_READ_TIMEOUT_MS,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_DEPTH,
  type HostProxyRunLandoSession,
  type HostProxyRunLandoSessionOptions,
  makeHostProxyToken,
  resolveHostProxyShimArtifact,
  sessionPaths,
} from "./transport-session.ts";
import { installHostProxyShim } from "./transport-shim.ts";

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
export { cleanupHostProxyRunLandoState } from "./transport-lifecycle.ts";
export { hostProxyRunLandoStateDir } from "./transport-session.ts";
export type {
  HostProxyRunLandoSession,
  HostProxyRunLandoSessionOptions,
  HostProxyTransportKind,
} from "./transport-session.ts";
export {
  HOST_PROXY_SHIM_ARTIFACT,
  HOST_PROXY_SHIM_ARTIFACT_ENV,
  HOST_PROXY_SHIM_SOURCE,
} from "./transport-shim.ts";

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
  return Effect.gen(function* () {
    const runtimeContext = yield* Effect.context<EventService | RedactionService>();
    const sessionId = makeHostProxyToken();
    const token = makeHostProxyToken();
    const controlToken = options.controlToken ?? makeHostProxyToken();
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const bodyReadTimeoutMs = options.bodyReadTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS;
    const shimArtifact = resolveHostProxyShimArtifact(options);
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

    const listenResult = yield* listenHostProxyServer(server, paths, options);
    socketOwned = listenResult.socketOwned;

    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolveClosedPromise) => {
      resolveClosed = resolveClosedPromise;
    });
    const close = async () => {
      closePromise ??= closeHostProxyServer(server, paths, inFlight).finally(resolveClosed);
      await closePromise;
    };
    shutdownRef.current = close;

    return {
      ...session,
      ...(paths.socketPath === undefined ? {} : { socketPath: paths.socketPath }),
      ...(listenResult.url === undefined ? {} : { url: listenResult.url }),
      ...(listenResult.containerUrl === undefined ? {} : { containerUrl: listenResult.containerUrl }),
      shimPath: paths.shimPath,
      transport: paths.transport,
      close,
      closed,
    };
  }).pipe(
    Effect.catchAll((failure) =>
      removeSessionState(paths, socketOwned).pipe(
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
