import { realpath, stat } from "node:fs/promises";
import { isErrnoCode } from "@lando/sdk/errors";
import type { ProcessRunner } from "@lando/sdk/services";
import { Effect, Result } from "effect";

import { hasHostSystemd } from "./host-systemd.ts";
import {
  type AcquisitionDecision,
  DESIRED_HTTPS_PORT,
  DESIRED_HTTP_PORT,
  defaultAcquisitionFingerprint,
} from "./port-acquisition.ts";
import type { SocketProxyDependencies } from "./proxy-types.ts";
import { type SocketProxyArtifactClassification, foreignSocketProxyNotice } from "./socket-proxy-helper.ts";
import {
  classifySocketProxy,
  hopsMatchTargets,
  isSocketProxyInstalled,
  probeSocketProxy,
  startSockets,
} from "./socket-proxy-install.ts";
import { SOCKET_HELPER_CHANGE } from "./socket-proxy-plan.ts";

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

/** `lando start` never installs the helper; setup or `doctor --fix` does, after asking. */
const HELPER_SETUP_NOTICE =
  "Ports 80 and 443 need Lando's port helper, which only `lando setup` or `lando doctor --fix` installs, after asking. Lando keeps its fallback ports until then.";

/** Starting the helper never elevates; repairing it as root is the approved helper change. */
const HELPER_START_FAILED_NOTICE =
  "Lando's port helper is installed, but its sockets did not start with the access it grants this account, so Lando keeps its fallback ports. Run `lando doctor --fix` to repair it, after asking.";

const foreignNotice = (
  ownership: SocketProxyArtifactClassification,
  intent: SocketProxySetupIntent,
): string => foreignSocketProxyNotice(ownership, intent === "configure" ? "commands" : "brief");

type HelperResolution = {
  readonly decision: AcquisitionDecision;
  readonly helperInstalled: boolean;
  readonly socketsActive: boolean;
};

const fallback = (notices: ReadonlyArray<string>, helperInstalled = false): HelperResolution => ({
  decision: { ...helperDecision("needs-helper"), notices: notices.filter((notice) => notice.length > 0) },
  helperInstalled,
  socketsActive: false,
});

const replacementSuccessNotice = (ownership: SocketProxyArtifactClassification): string | undefined => {
  if (ownership.kind !== "foreign") return undefined;
  if (ownership.reason === "missing-root") {
    return `Took over the socket proxy left by a removed Lando install${ownership.ownerRoot === undefined ? "" : ` (${ownership.ownerRoot})`}; this install now serves ports 80 and 443.`;
  }
  if (ownership.reason === "unattributed") {
    return "Took over the socket proxy from an older Lando build; this install now serves ports 80 and 443.";
  }
  return undefined;
};

/**
 * Start (or confirm) the sockets of a helper this run installed or already owned. Starting goes
 * only through the helper's polkit grant, never as root.
 */
const activate = Effect.fnUntraced(function* (
  socketProxy: SocketProxyDependencies,
  installedNow: boolean,
  notice: string | undefined,
): Effect.fn.Return<HelperResolution> {
  const started = yield* installedNow ? probeSocketProxy(socketProxy) : startSockets(socketProxy);
  if (started.kind === "started" && started.http.kind === "success" && started.https.kind === "success") {
    return {
      decision: { ...helperDecision("socket-helper"), notices: notice === undefined ? [] : [notice] },
      helperInstalled: true,
      socketsActive: true,
    };
  }
  if (!installedNow) return fallback([HELPER_START_FAILED_NOTICE], true);
  return fallback(
    [
      `${notice === undefined ? "" : `${notice} `}The helper is installed but its sockets are not active yet; run \`lando setup\` again.`,
    ],
    true,
  );
});

/**
 * The router's helper decision once ports 80 and 443 need it. `ensure` (app start) only starts a
 * helper this data root already owns with the right hops. `configure` (setup, doctor --fix)
 * also applies the run's approved `proxy-traefik:install-socket-helper` change, which installs,
 * retargets, or takes over the helper with exactly the planned script. A failure keeps the
 * fallback ports with a notice; the router itself never fails over its helper.
 */
export const resolveNeedsHelper = Effect.fnUntraced(
  function* (
    socketProxy: SocketProxyDependencies,
    hops: HelperHopTargets,
  ): Effect.fn.Return<HelperResolution> {
    const intent: SocketProxySetupIntent = socketProxy.intent ?? "ensure";
    if (!socketProxy.hasHostSystemd()) return fallback([]);
    const ownership = yield* classifySocketProxy(socketProxy);
    const approved =
      intent === "configure" && socketProxy.hostChanges?.approved(SOCKET_HELPER_CHANGE) !== undefined
        ? socketProxy.hostChanges
        : undefined;
    const foreign = ownership.kind === "foreign" || ownership.kind === "unmarked";
    const alreadyInstalled = !foreign && (yield* isSocketProxyInstalled(socketProxy));
    if (approved === undefined) {
      if (foreign) return fallback([foreignNotice(ownership, intent)]);
      if (alreadyInstalled && (yield* hopsMatchTargets(socketProxy, hops.httpTarget, hops.httpsTarget))) {
        return yield* activate(socketProxy, false, undefined);
      }
      return fallback(intent === "ensure" ? [HELPER_SETUP_NOTICE] : [], alreadyInstalled);
    }
    const applied = yield* approved.apply(SOCKET_HELPER_CHANGE).pipe(Effect.result);
    if (Result.isFailure(applied)) {
      const error = applied.failure;
      return fallback([`${error.message} ${error.remediation}`], alreadyInstalled);
    }
    return yield* activate(
      socketProxy,
      applied.success.outcome === "applied",
      replacementSuccessNotice(ownership),
    );
  },
  Effect.catch(() => Effect.succeed(fallback([]))),
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
  readonly processRunner: typeof ProcessRunner.Service | undefined;
}): SocketProxyDependencies | undefined => {
  if (input.processRunner === undefined) return undefined;
  return {
    user: process.env.USER ?? process.env.LOGNAME ?? "lando",
    userDataRoot: input.userDataRoot,
    realpath: (path) => Effect.tryPromise({ try: () => realpath(path), catch: (error) => error }),
    hasHostSystemd,
    exists: hostExists,
    readText: hostReadText,
    processRunner: input.processRunner,
  };
};
