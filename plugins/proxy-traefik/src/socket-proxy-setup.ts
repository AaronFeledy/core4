import { Effect } from "effect";

import type { InteractionService, PrivilegeService, ProcessRunner } from "@lando/sdk/services";

import { hasHostSystemd } from "./host-systemd.ts";
import { type AcquisitionDecision, DESIRED_HTTPS_PORT, DESIRED_HTTP_PORT } from "./port-acquisition.ts";
import { TRAEFIK_HTTPS_PORT, TRAEFIK_HTTP_PORT } from "./ports.ts";
import type { SocketProxyDependencies } from "./proxy-types.ts";
import { installSocketProxy, isSocketProxyInstalled, startSockets } from "./socket-proxy-install.ts";

const degraded = (): AcquisitionDecision => ({
  mode: "degraded-high-ports",
  httpPort: TRAEFIK_HTTP_PORT,
  httpsPort: TRAEFIK_HTTPS_PORT,
  notices: [],
});

const socketHelper = (): AcquisitionDecision => ({
  mode: "socket-helper",
  httpPort: DESIRED_HTTP_PORT,
  httpsPort: DESIRED_HTTPS_PORT,
  notices: [],
});

const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
};

const consentToInstall = (
  socketProxy: SocketProxyDependencies,
  alreadyInstalled: boolean,
): Effect.Effect<boolean> => {
  if (alreadyInstalled || socketProxy.autoApprove === true) return Effect.succeed(true);
  const interaction = socketProxy.interaction;
  if (interaction === undefined) return Effect.succeed(true);
  return Effect.gen(function* () {
    const tty = yield* interaction.isInteractive;
    if (!tty) return true;
    return yield* Effect.scoped(
      interaction.confirm({
        name: "install-socket-proxy",
        message: "Install a systemd socket proxy so Lando can serve http://*.lndo.site on ports 80 and 443?",
        default: true,
      }),
    ).pipe(Effect.catchAll(() => Effect.succeed(true)));
  });
};

export const resolveNeedsHelper = (
  socketProxy: SocketProxyDependencies,
): Effect.Effect<{
  readonly decision: AcquisitionDecision;
  readonly helperInstalled: boolean;
  readonly socketsActive: boolean;
}> =>
  Effect.gen(function* () {
    if (!socketProxy.hasHostSystemd()) {
      return { decision: degraded(), helperInstalled: false, socketsActive: false };
    }
    const alreadyInstalled = yield* isSocketProxyInstalled(socketProxy);
    if (!(yield* consentToInstall(socketProxy, alreadyInstalled))) {
      return { decision: degraded(), helperInstalled: alreadyInstalled, socketsActive: false };
    }
    const installed = yield* installSocketProxy(socketProxy);
    switch (installed.kind) {
      case "installed":
      case "already-installed":
        break;
      case "elevation-refused":
      case "proxyd-missing":
        return { decision: degraded(), helperInstalled: false, socketsActive: false };
      default:
        return assertNever(installed);
    }
    const started = yield* startSockets({
      processRunner: socketProxy.processRunner,
      privilege: socketProxy.privilege,
      ...(socketProxy.probeForward === undefined ? {} : { probeForward: socketProxy.probeForward }),
    });
    if (started.kind === "started" && started.http.kind === "success" && started.https.kind === "success") {
      return { decision: socketHelper(), helperInstalled: true, socketsActive: true };
    }
    return { decision: degraded(), helperInstalled: true, socketsActive: false };
  }).pipe(
    Effect.catchAll(() =>
      Effect.succeed({ decision: degraded(), helperInstalled: false, socketsActive: false }),
    ),
  );

const hostExists = (path: string): Effect.Effect<boolean> => Effect.promise(() => Bun.file(path).exists());

const hostReadText = (path: string): Effect.Effect<string, unknown> =>
  Effect.tryPromise({ try: () => Bun.file(path).text(), catch: (error) => error });

export const liveSocketProxy = (input: {
  readonly privilege: typeof PrivilegeService.Service | undefined;
  readonly processRunner: typeof ProcessRunner.Service | undefined;
  readonly interaction: typeof InteractionService.Service | undefined;
}): SocketProxyDependencies | undefined => {
  if (input.privilege === undefined || input.processRunner === undefined) return undefined;
  return {
    user: process.env.USER ?? process.env.LOGNAME ?? "lando",
    hasHostSystemd,
    exists: hostExists,
    readText: hostReadText,
    processRunner: input.processRunner,
    privilege: input.privilege,
    ...(input.interaction === undefined ? {} : { interaction: input.interaction }),
  };
};
