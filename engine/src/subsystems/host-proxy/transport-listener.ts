import { chmod } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Effect } from "effect";

import { HostProxySocketStaleError, HostProxyTransportUnavailableError } from "@lando/sdk/errors";

import type { HostProxyRunLandoSessionOptions, HostProxySessionPaths } from "./transport-session.ts";

export interface HostProxyListenResult {
  readonly socketOwned: boolean;
  readonly url?: string;
  readonly containerUrl?: string;
}

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

const tcpListenResult = (
  server: Server,
  paths: HostProxySessionPaths,
  options: Pick<HostProxyRunLandoSessionOptions, "hostGatewayName">,
): Effect.Effect<HostProxyListenResult, HostProxyTransportUnavailableError> => {
  const address = server.address() as AddressInfo | null;
  if (address === null) {
    return Effect.fail(
      new HostProxyTransportUnavailableError({
        message: "Host-proxy TCP bridge did not report a listening address.",
        socketPath: paths.stateDir,
        remediation: "Restart the app so Lando can recreate the host-proxy bridge.",
      }),
    );
  }
  const url = `http://127.0.0.1:${address.port}`;
  return Effect.succeed({
    socketOwned: true,
    url,
    containerUrl: `http://${options.hostGatewayName ?? "host.containers.internal"}:${address.port}`,
  });
};

const secureSocket = (
  server: Server,
  paths: HostProxySessionPaths,
): Effect.Effect<void, HostProxyTransportUnavailableError> => {
  if (paths.transport !== "unix-socket" || paths.socketPath === undefined) return Effect.void;
  const socketPath = paths.socketPath;
  return Effect.async<void, HostProxyTransportUnavailableError>((resume) => {
    void chmod(socketPath, 0o600).then(
      () => resume(Effect.void),
      (cause) => {
        server.close(() => {
          resume(
            Effect.fail(
              new HostProxyTransportUnavailableError({
                message: cause instanceof Error ? cause.message : String(cause),
                socketPath,
                remediation: "Ensure the app run directory is writable.",
              }),
            ),
          );
        });
      },
    );
  });
};

export const listenHostProxyServer = (
  server: Server,
  paths: HostProxySessionPaths,
  options: Pick<HostProxyRunLandoSessionOptions, "hostGatewayName">,
): Effect.Effect<HostProxyListenResult, HostProxySocketStaleError | HostProxyTransportUnavailableError> =>
  Effect.async<HostProxyListenResult, HostProxySocketStaleError | HostProxyTransportUnavailableError>(
    (resume) => {
      let settled = false;
      const previousUmask = process.umask(0o177);
      const restoreUmask = (): void => {
        process.umask(previousUmask);
      };
      const fail = (failure: HostProxySocketStaleError | HostProxyTransportUnavailableError): void => {
        if (settled) return;
        settled = true;
        restoreUmask();
        resume(Effect.fail(failure));
      };
      server.once("error", (cause) => {
        fail(listenFailure(cause, paths.socketPath ?? paths.stateDir));
      });
      const completeListen = (): void => {
        if (settled) return;
        settled = true;
        restoreUmask();
        const listenResult =
          paths.transport === "tcp-host-gateway"
            ? tcpListenResult(server, paths, options)
            : Effect.succeed({ socketOwned: true });
        resume(listenResult.pipe(Effect.zipLeft(secureSocket(server, paths))));
      };
      if (paths.transport === "tcp-host-gateway") {
        server.listen(0, "127.0.0.1", completeListen);
      } else if (paths.socketPath !== undefined) {
        server.listen(paths.socketPath, completeListen);
      }
    },
  );
