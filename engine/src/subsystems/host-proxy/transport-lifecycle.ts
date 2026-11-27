import { rm, rmdir } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";
import type { RootOverrides } from "@lando/paths";
import { errnoCode } from "@lando/sdk/errors";
import type { AppRef } from "@lando/sdk/schema";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Fiber } from "effect";
import { HOST_PROXY_CREDENTIALS_NAME } from "./run-directory.ts";
import type { HostProxyInFlightRequest } from "./transport-handler.ts";
import type { HostProxySessionPaths } from "./transport-session.ts";

/**
 * Ends the app's host-proxy worker. `stop` keeps the container-facing directory and its generation
 * so the app's stopped containers start again in place; `retire` removes the whole run directory.
 */
export const cleanupHostProxyRunLandoState = Effect.fnUntraced(
  function* (
    app: Pick<AppRef, "id" | "root">,
    paths: RootOverrides | undefined,
    intent: "stop" | "retire",
  ): Effect.fn.Return<void, never, PrivateFileAccessService> {
    const privateFileAccess = yield* PrivateFileAccessService;
    const ownership = yield* Effect.promise(() => import("./worker-ownership.ts"));
    if (intent === "retire") {
      yield* ownership.removeOwnedHostProxyWorkerState(app, paths, { privateFileAccess });
      return;
    }
    yield* ownership.stopOwnedHostProxyWorker(app, {
      privateFileAccess,
      ...(paths === undefined ? {} : { paths }),
    });
  },
  Effect.catch(() => Effect.void),
);

export const removeSessionState = (paths: HostProxySessionPaths, socketOwned: boolean): Effect.Effect<void> =>
  Effect.promise(async () => {
    // The container-facing directory stays: running containers bind it, and the next session
    // publishes its socket and credentials into that same directory.
    await rm(join(paths.containerDir, HOST_PROXY_CREDENTIALS_NAME), { force: true });
    await rm(paths.shimPath, { force: true });
    if (socketOwned && paths.transport === "unix-socket" && paths.socketPath !== undefined) {
      await rm(paths.socketPath, { force: true });
    }
    // The parent owns worker.json. Never remove it or wait for its lock during shutdown.
    await rmdir(paths.stateDir).catch((cause: unknown) => {
      const code = errnoCode(cause);
      if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return;
      throw cause;
    });
  });

export const closeHostProxyServer = async (
  server: Server,
  paths: HostProxySessionPaths,
  inFlight: ReadonlySet<HostProxyInFlightRequest>,
): Promise<void> => {
  const requests = [...inFlight];
  const serverClosed = new Promise<void>((resolveClose, rejectClose) =>
    server.close((cause) => (cause === undefined ? resolveClose() : rejectClose(cause))),
  );
  for (const request of requests) request.response.destroy();
  await Effect.runPromise(Fiber.interruptAll(requests.map(({ fiber }) => fiber)));
  server.closeAllConnections();
  await serverClosed;
  await Effect.runPromise(removeSessionState(paths, true));
};
