import { realpath, stat } from "node:fs/promises";

import { Effect, absurd } from "effect";

import { isErrnoCode } from "@lando/sdk/errors";
import type { InteractionService, PrivilegeService, ProcessRunner } from "@lando/sdk/services";

import { hasHostSystemd } from "./host-systemd.ts";
import {
  type AcquisitionDecision,
  DESIRED_HTTPS_PORT,
  DESIRED_HTTP_PORT,
  defaultAcquisitionFingerprint,
  probeBind,
} from "./port-acquisition.ts";
import type { SocketProxyDependencies } from "./proxy-types.ts";
import {
  SOCKET_PROXY_MANUAL_REMOVAL_COMMANDS,
  type SocketProxyArtifactClassification,
  foreignSocketProxyNotice,
} from "./socket-proxy-helper.ts";
import {
  classifySocketProxy,
  installSocketProxy,
  isSocketProxyInstalled,
  probeSocketProxy,
  readAnyHelperHopTargets,
  startSockets,
} from "./socket-proxy-install.ts";

export type HelperHopTargets = {
  readonly httpTarget: number;
  readonly httpsTarget: number;
};

type SocketProxySetupIntent = "configure" | "ensure";

const helperDecision = (mode: "needs-helper" | "socket-helper"): AcquisitionDecision => ({
  mode,
  httpPort: DESIRED_HTTP_PORT,
  httpsPort: DESIRED_HTTPS_PORT,
  notices: [],
  fingerprint: defaultAcquisitionFingerprint(),
});

const foreignNotice = (
  ownership: SocketProxyArtifactClassification,
  intent: SocketProxySetupIntent,
): string => foreignSocketProxyNotice(ownership, intent === "configure" ? "commands" : "brief");

const consentToInstall = Effect.fnUntraced(function* (
  socketProxy: SocketProxyDependencies,
  alreadyInstalled: boolean,
): Effect.fn.Return<boolean> {
  if (alreadyInstalled || socketProxy.autoApprove === true) return true;
  const interaction = socketProxy.interaction;
  if (interaction === undefined) return true;
  const tty = yield* interaction.isInteractive;
  if (!tty) return true;
  return yield* Effect.scoped(
    interaction.confirm({
      name: "install-socket-proxy",
      message: "Install a systemd socket proxy so Lando can serve local HTTP/HTTPS on ports 80 and 443?",
      default: true,
    }),
  ).pipe(Effect.catch(() => Effect.succeed(true)));
});

/** Real interactive confirm only. Missing interaction, errors, and cancel decline. */
const confirmReplace = Effect.fnUntraced(function* (
  socketProxy: SocketProxyDependencies,
  message: string,
  name: string,
): Effect.fn.Return<"yes" | "no" | "cancel"> {
  const interaction = socketProxy.interaction;
  if (interaction === undefined) return "no";
  return yield* Effect.scoped(interaction.confirm({ name, message, default: true })).pipe(
    Effect.map((ok) => (ok ? ("yes" as const) : ("no" as const))),
    Effect.catch(() => Effect.succeed("cancel" as const)),
  );
});

const hopsFreeOrOwned = Effect.fnUntraced(function* (
  socketProxy: SocketProxyDependencies,
  hops: HelperHopTargets | undefined,
  ownedPorts: ReadonlySet<number> | undefined,
): Effect.fn.Return<boolean> {
  // Automatic replacement must prove BOTH old hop targets; unknown hops never auto-replace.
  if (hops === undefined) return false;
  const probe = socketProxy.probeBind ?? probeBind;
  for (const port of [hops.httpTarget, hops.httpsTarget]) {
    const bind = yield* probe("127.0.0.1", port);
    if (bind.kind === "success") continue;
    if (bind.kind === "EADDRINUSE" && ownedPorts?.has(port) === true) continue;
    return false;
  }
  return true;
});

/**
 * Whether configure may replace a foreign helper automatically (autoApprove / non-interactive).
 * missing-root: only when both old hop targets are free or provider-owned by this root.
 * unattributed: never automatic (interactive confirm only).
 */
const mayAutoReplace = Effect.fnUntraced(function* (
  socketProxy: SocketProxyDependencies,
  ownership: SocketProxyArtifactClassification,
): Effect.fn.Return<boolean> {
  if (ownership.kind !== "foreign") return false;
  if (ownership.reason !== "missing-root") return false;
  const hops = yield* readAnyHelperHopTargets(socketProxy);
  return yield* hopsFreeOrOwned(socketProxy, hops, socketProxy.ownedRouterPorts);
});

const sessionIsInteractive = Effect.fnUntraced(function* (
  socketProxy: SocketProxyDependencies,
): Effect.fn.Return<boolean> {
  const interaction = socketProxy.interaction;
  if (interaction === undefined) return false;
  return yield* interaction.isInteractive;
});

const replacementSuccessNotice = (ownership: SocketProxyArtifactClassification): string => {
  if (ownership.kind !== "foreign")
    return "This install now serves ports 80 and 443 through its socket proxy.";
  if (ownership.reason === "missing-root") {
    return `Took over the socket proxy left by a removed Lando install${ownership.ownerRoot === undefined ? "" : ` (${ownership.ownerRoot})`}; this install now serves ports 80 and 443.`;
  }
  if (ownership.reason === "unattributed") {
    return "Took over the socket proxy from an older Lando build; this install now serves ports 80 and 443.";
  }
  return "This install now serves ports 80 and 443 through its socket proxy.";
};

export const resolveNeedsHelper = Effect.fnUntraced(
  function* (
    socketProxy: SocketProxyDependencies,
    hops: HelperHopTargets,
  ): Effect.fn.Return<{
    readonly decision: AcquisitionDecision;
    readonly helperInstalled: boolean;
    readonly socketsActive: boolean;
  }> {
    const intent: SocketProxySetupIntent = socketProxy.intent ?? "ensure";
    if (!socketProxy.hasHostSystemd()) {
      return { decision: helperDecision("needs-helper"), helperInstalled: false, socketsActive: false };
    }
    const ownership = yield* classifySocketProxy(socketProxy);

    // ensure: never write/retarget/start/stop foreign or unmarked artifacts.
    if (ownership.kind === "foreign" || ownership.kind === "unmarked") {
      if (intent === "ensure") {
        const notice = foreignNotice(ownership, intent);
        return {
          decision: {
            ...helperDecision("needs-helper"),
            notices: notice.length > 0 ? [notice] : [],
          },
          helperInstalled: false,
          socketsActive: false,
        };
      }

      // configure: other-root / unmarked / mixed NEVER replace.
      if (
        ownership.kind === "unmarked" ||
        (ownership.kind === "foreign" && (ownership.reason === "other-root" || ownership.reason === "mixed"))
      ) {
        const notice = foreignNotice(ownership, "configure");
        return {
          decision: {
            ...helperDecision("needs-helper"),
            notices: notice.length > 0 ? [notice] : [],
          },
          helperInstalled: false,
          socketsActive: false,
        };
      }

      const interactive = yield* sessionIsInteractive(socketProxy);
      const mayAuto = socketProxy.autoApprove === true || !interactive;
      let replace = false;
      if (ownership.kind === "foreign" && ownership.reason === "missing-root") {
        if (mayAuto) {
          replace = yield* mayAutoReplace(socketProxy, ownership);
        } else {
          const answer = yield* confirmReplace(
            socketProxy,
            `A Lando install that no longer exists (${ownership.ownerRoot}) left a socket proxy on ports 80 and 443. Take it over for this install?`,
            "replace-missing-root-socket-proxy",
          );
          replace = answer === "yes";
        }
      } else if (ownership.kind === "foreign" && ownership.reason === "unattributed") {
        // Unattributed: ONLY a real interactive confirm may replace.
        if (interactive && socketProxy.autoApprove !== true) {
          const answer = yield* confirmReplace(
            socketProxy,
            "An older Lando build installed the socket proxy on ports 80 and 443 without recording its owner. Take it over for this install? Any other Lando install using it will switch to fallback ports.",
            "replace-unattributed-socket-proxy",
          );
          replace = answer === "yes";
        }
      }

      if (!replace) {
        const notice = foreignNotice(ownership, "configure");
        return {
          decision: {
            ...helperDecision("needs-helper"),
            notices: notice.length > 0 ? [notice] : [],
          },
          helperInstalled: false,
          socketsActive: false,
        };
      }

      const installed = yield* installSocketProxy({
        ...socketProxy,
        httpTarget: hops.httpTarget,
        httpsTarget: hops.httpsTarget,
        replaceForeign: true,
      });
      switch (installed.kind) {
        case "installed":
        case "already-installed":
          break;
        case "elevation-refused":
        case "proxyd-missing":
        case "needs-helper":
        case "foreign":
          return {
            decision: {
              ...helperDecision("needs-helper"),
              notices: [
                foreignNotice(yield* classifySocketProxy(socketProxy), "configure") ||
                  `Socket proxy helper could not be replaced. Review it before manual removal:\n${SOCKET_PROXY_MANUAL_REMOVAL_COMMANDS}`,
              ],
            },
            helperInstalled: false,
            socketsActive: false,
          };
        default:
          return absurd<never>(installed);
      }
      const started = yield* installed.kind === "installed"
        ? probeSocketProxy(socketProxy)
        : startSockets(socketProxy);
      const successExplanation = replacementSuccessNotice(ownership);
      if (started.kind === "started" && started.http.kind === "success" && started.https.kind === "success") {
        return {
          decision: { ...helperDecision("socket-helper"), notices: [successExplanation] },
          helperInstalled: true,
          socketsActive: true,
        };
      }
      return {
        decision: {
          ...helperDecision("needs-helper"),
          notices: [
            `${successExplanation} The helper is installed but sockets are not active yet; run \`lando setup\` or start the proxy sockets.`,
          ],
        },
        helperInstalled: true,
        socketsActive: false,
      };
    }

    const alreadyInstalled = yield* isSocketProxyInstalled(socketProxy);
    if (!(yield* consentToInstall(socketProxy, alreadyInstalled))) {
      return {
        decision: helperDecision("needs-helper"),
        helperInstalled: alreadyInstalled,
        socketsActive: false,
      };
    }
    const installed = yield* installSocketProxy({
      ...socketProxy,
      httpTarget: hops.httpTarget,
      httpsTarget: hops.httpsTarget,
    });
    switch (installed.kind) {
      case "installed":
      case "already-installed":
        break;
      case "elevation-refused":
      case "proxyd-missing":
      case "needs-helper":
        return {
          decision: helperDecision("needs-helper"),
          helperInstalled: alreadyInstalled,
          socketsActive: false,
        };
      case "foreign":
        return {
          decision: {
            ...helperDecision("needs-helper"),
            notices: [
              foreignNotice(yield* classifySocketProxy(socketProxy), intent) ||
                (intent === "configure"
                  ? `Socket proxy helper ownership changed during installation. Review it before manual removal:\n${SOCKET_PROXY_MANUAL_REMOVAL_COMMANDS}`
                  : "socket proxy ownership changed during installation"),
            ],
          },
          helperInstalled: false,
          socketsActive: false,
        };
      default:
        return absurd<never>(installed);
    }
    const started = yield* installed.kind === "installed"
      ? probeSocketProxy(socketProxy)
      : startSockets(socketProxy);
    if (started.kind === "started" && started.http.kind === "success" && started.https.kind === "success") {
      return { decision: helperDecision("socket-helper"), helperInstalled: true, socketsActive: true };
    }
    return { decision: helperDecision("needs-helper"), helperInstalled: true, socketsActive: false };
  },
  Effect.catch(() =>
    Effect.succeed({
      decision: helperDecision("needs-helper"),
      helperInstalled: false,
      socketsActive: false,
    }),
  ),
);

// Owner roots are directories, which `Bun.file(path).exists()` reports as absent. Only a
// missing path is absent; an unreadable one stays present so ownership fails closed.
const hostExists = (path: string): Effect.Effect<boolean> =>
  Effect.tryPromise({ try: () => stat(path), catch: (error) => error }).pipe(
    Effect.as(true),
    Effect.catch((error) => Effect.succeed(!isErrnoCode(error, "ENOENT") && !isErrnoCode(error, "ENOTDIR"))),
  );

const hostReadText = (path: string): Effect.Effect<string, unknown> =>
  Effect.tryPromise({ try: () => Bun.file(path).text(), catch: (error) => error });

export const liveSocketProxy = (input: {
  readonly userDataRoot: string;
  readonly privilege: typeof PrivilegeService.Service | undefined;
  readonly processRunner: typeof ProcessRunner.Service | undefined;
  readonly interaction: typeof InteractionService.Service | undefined;
}): SocketProxyDependencies | undefined => {
  if (input.privilege === undefined || input.processRunner === undefined) return undefined;
  return {
    user: process.env.USER ?? process.env.LOGNAME ?? "lando",
    userDataRoot: input.userDataRoot,
    realpath: (path) => Effect.tryPromise({ try: () => realpath(path), catch: (error) => error }),
    hasHostSystemd,
    exists: hostExists,
    readText: hostReadText,
    processRunner: input.processRunner,
    privilege: input.privilege,
    ...(input.interaction === undefined ? {} : { interaction: input.interaction }),
  };
};
