import { rm } from "node:fs/promises";
import type { Server } from "node:http";

import { Effect, Fiber } from "effect";

import type { AppRef } from "@lando/sdk/schema";
import { ProcessRunner } from "@lando/sdk/services";

import type { RootOverrides } from "@lando/paths";
import { makeOwnerOnlyFileAccess } from "@lando/state-store/private-file-access";
import type { HostProxyInFlightRequest } from "./transport-handler.ts";
import type { HostProxySessionPaths } from "./transport-session.ts";

export const cleanupHostProxyRunLandoState = (
  app: AppRef,
  paths?: RootOverrides,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const processRunner = yield* Effect.serviceOption(ProcessRunner);
    const { removeOwnedHostProxyWorkerState } = yield* Effect.promise(() => import("./worker-ownership.ts"));
    yield* removeOwnedHostProxyWorkerState(app, paths, {
      privateFileAccess: makeOwnerOnlyFileAccess(
        processRunner._tag === "Some" ? { processRunner: processRunner.value } : {},
      ),
    });
  }).pipe(Effect.catchAll(() => Effect.void));

export const removeSessionState = (paths: HostProxySessionPaths, socketOwned: boolean): Effect.Effect<void> =>
  Effect.promise(async () => {
    await rm(paths.stateDir, { recursive: true, force: true });
    if (socketOwned && paths.transport === "unix-socket" && paths.socketPath !== undefined) {
      await rm(paths.socketPath, { force: true });
    }
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
  await rm(paths.stateDir, { recursive: true, force: true });
};
