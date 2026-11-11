import { rm, rmdir } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";

import { Effect, Fiber } from "effect";

import type { RootOverrides } from "@lando/paths";
import { errnoCode } from "@lando/sdk/errors";
import type { AppRef } from "@lando/sdk/schema";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import type { HostProxyInFlightRequest } from "./transport-handler.ts";
import type { HostProxySessionPaths } from "./transport-session.ts";

export const cleanupHostProxyRunLandoState = Effect.fnUntraced(
  function* (
    app: Pick<AppRef, "id" | "root">,
    paths?: RootOverrides,
  ): Effect.fn.Return<void, never, PrivateFileAccessService> {
    const privateFileAccess = yield* PrivateFileAccessService;
    const { removeOwnedHostProxyWorkerState } = yield* Effect.promise(() => import("./worker-ownership.ts"));
    yield* removeOwnedHostProxyWorkerState(app, paths, {
      privateFileAccess,
    });
  },
  Effect.catch(() => Effect.void),
);

export const removeSessionState = (paths: HostProxySessionPaths, socketOwned: boolean): Effect.Effect<void> =>
  Effect.promise(async () => {
    await rm(join(paths.stateDir, "credentials"), { force: true });
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
