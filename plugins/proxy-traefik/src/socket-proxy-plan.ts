/**
 * The router's port helper as a planned host change. Planning is read-only: it probes ports 80
 * and 443 and the helper's hop candidates, classifies who owns any existing helper, and builds
 * the exact install script with the chosen hops. Applying re-plans against the host and runs
 * nothing when the host moved away from the plan (hops taken, helper ownership changed).
 *
 * This data root's own helper whose hops match but whose sockets are down is planned as a
 * repair: applying first starts it through its polkit grant, as `lando start` does, and runs the
 * install script as root only when that fails. Nothing else ever starts or stops it as root.
 *
 * A helper owned by another Lando data root, by nobody Lando can prove, or by a mix is never
 * planned. Taking over one left by a removed data root is an ordinary standard change; one an
 * older build installed without recording its owner is offered only as a terminal question.
 */
import { HostChangeFailedError, HostChangeStaleError } from "@lando/sdk/errors";
import { type HostChange, HostChangeId } from "@lando/sdk/schema";
import type { HostChangeProposal } from "@lando/sdk/services";
import { Effect, Result } from "effect";

import { chooseHelperBindPorts, isOurSocketHelperHolder } from "./port-acquisition.ts";
import {
  type ProbedAcquisition,
  preferredEacces,
  probeCurrent,
  resolveTryLists,
} from "./port-acquisition-helpers.ts";
import { ownedRouterPorts, usableHelperHopTargets } from "./port-acquisition-ownership.ts";
import type { SocketProxyDependencies, TraefikProxyDependencies } from "./proxy-types.ts";
import type { SocketProxyArtifactClassification } from "./socket-proxy-helper.ts";
import {
  SOCKET_PROXY_INSTALL_STEP,
  type SocketProxyStartOutcome,
  classifySocketProxy,
  inspectSocketProxyInstall,
  isSocketProxyInstalled,
  readAnyHelperHopTargets,
  runSocketProxyInstall,
  startSockets,
} from "./socket-proxy-install.ts";

export const SOCKET_HELPER_CHANGE = HostChangeId.make("proxy-traefik:install-socket-helper");

export interface SocketHelperPlan {
  readonly ownership: SocketProxyArtifactClassification;
  readonly takeover: boolean;
  /** This data root's helper already has these hops; only its sockets are down. */
  readonly repair: boolean;
  readonly httpTarget: number;
  readonly httpsTarget: number;
  readonly script: string;
}

type PlanningDependencies = TraefikProxyDependencies & { readonly socketProxy: SocketProxyDependencies };

const helperOwnsPreferred = (probed: ProbedAcquisition): boolean =>
  isOurSocketHelperHolder(probed.http) && isOurSocketHelperHolder(probed.https);

const socketsServe = (started: SocketProxyStartOutcome): boolean =>
  started.kind === "started" && started.http.kind === "success" && started.https.kind === "success";

const isTakeover = (ownership: SocketProxyArtifactClassification): boolean =>
  ownership.kind === "foreign" &&
  (ownership.reason === "missing-root" || ownership.reason === "unattributed");

/** Read-only: whether setup should install, retarget, or take over the helper, and exactly how. */
export const planSocketHelper = Effect.fnUntraced(function* (
  dependencies: PlanningDependencies,
): Effect.fn.Return<SocketHelperPlan | undefined, unknown> {
  const socketProxy = dependencies.socketProxy;
  const lists = resolveTryLists(dependencies);
  const linuxLike = dependencies.paths.platform === "linux" || dependencies.paths.platform === "wsl";
  if (!linuxLike || lists.bindAddress !== "127.0.0.1" || !socketProxy.hasHostSystemd()) return undefined;
  const probed = yield* probeCurrent(dependencies, lists);
  const installed = yield* isSocketProxyInstalled(socketProxy);
  const serving = installed && helperOwnsPreferred(probed);
  if (serving && (yield* usableHelperHopTargets(dependencies, probed, lists.bindAddress)) !== undefined) {
    return undefined;
  }
  const ownership = yield* classifySocketProxy(socketProxy);
  const takeover = isTakeover(ownership);
  if ((ownership.kind === "foreign" && !takeover) || ownership.kind === "unmarked") return undefined;
  const retarget = ownership.kind === "owned" && serving;
  if (!preferredEacces(probed) && !retarget && !takeover) return undefined;
  const occupied = [...Object.entries(probed.httpBinds), ...Object.entries(probed.httpsBinds)]
    .filter(([, bind]) => bind.kind === "EADDRINUSE")
    .map(([port]) => Number(port));
  const prior = takeover ? yield* readAnyHelperHopTargets(socketProxy) : undefined;
  const owned = yield* ownedRouterPorts(dependencies, [
    ...occupied,
    ...(prior === undefined ? [] : [prior.httpTarget, prior.httpsTarget]),
  ]);
  const hops = Result.try(() =>
    chooseHelperBindPorts({ httpBinds: probed.httpBinds, httpsBinds: probed.httpsBinds, ownedPorts: owned }),
  );
  if (Result.isFailure(hops)) return undefined;
  const httpTarget = hops.success.bindHttpPort;
  const httpsTarget = hops.success.bindHttpsPort;
  const target = { ...socketProxy, httpTarget, httpsTarget, ...(takeover ? { replaceForeign: true } : {}) };
  const current = yield* inspectSocketProxyInstall(target);
  // Matching hops with the sockets down: rewriting the same files restores a broken grant.
  const repair = current.kind === "already-installed" && !serving;
  const install = repair ? yield* inspectSocketProxyInstall({ ...target, rewriteMatching: true }) : current;
  if (install.kind !== "script") return undefined;
  return { ownership, takeover, repair, httpTarget, httpsTarget, script: install.script };
});

const summaryFor = (plan: SocketHelperPlan): string => {
  if (plan.takeover) return "Take over the helper that serves ports 80 and 443";
  if (plan.repair) return "Repair the helper that serves ports 80 and 443 if it cannot start";
  return "Install the helper that serves ports 80 and 443";
};

const reasonFor = (plan: SocketHelperPlan): string => {
  const serves = `Binding ports 80 and 443 needs administrator rights, so a systemd socket proxy that Lando owns serves them and forwards to the router on ports ${plan.httpTarget} and ${plan.httpsTarget}. Without it, URLs carry high ports.`;
  if (plan.repair) {
    return `${serves} Its sockets are not running. Lando first starts them with the access the helper grants this account; only if that fails does it rewrite the helper's files, which restores that access, and start them as root.`;
  }
  if (plan.ownership.kind !== "foreign") return serves;
  if (plan.ownership.reason === "missing-root") {
    return `${serves} A Lando install that no longer exists${plan.ownership.ownerRoot === undefined ? "" : ` (${plan.ownership.ownerRoot})`} left the current helper.`;
  }
  return `${serves} An older Lando build installed the current helper without recording its owner; any other Lando install using it switches to fallback ports.`;
};

const stale = (reason: string) =>
  new HostChangeStaleError({
    changeId: SOCKET_HELPER_CHANGE,
    reason,
    message: `The port helper's situation changed after setup planned it (${reason}), so Lando changed nothing and keeps its fallback ports.`,
    remediation: "Rerun `lando setup` so Lando can plan it again.",
  });

const installFailed = (message: string, exitCode?: number, stderr?: string) =>
  new HostChangeFailedError({
    changeId: SOCKET_HELPER_CHANGE,
    stepId: SOCKET_PROXY_INSTALL_STEP,
    message,
    remediation:
      "Review the helper with `lando doctor`, then rerun `lando setup`. Lando keeps its fallback ports.",
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(stderr === undefined ? {} : { stderr }),
  });

export const socketHelperProposal = (
  dependencies: PlanningDependencies,
  plan: SocketHelperPlan,
): HostChangeProposal => {
  const change: HostChange = {
    id: SOCKET_HELPER_CHANGE,
    owner: "@lando/proxy-traefik",
    stage: "proxy",
    summary: summaryFor(plan),
    reason: reasonFor(plan),
    consent:
      plan.ownership.kind === "foreign" && plan.ownership.reason === "unattributed"
        ? "interactive-only"
        : "standard",
    persistent: false,
    requirement: "recommended",
    details: { httpTarget: String(plan.httpTarget), httpsTarget: String(plan.httpsTarget) },
    steps: [
      {
        id: SOCKET_PROXY_INSTALL_STEP,
        summary: "Write the socket units and polkit rule, then start the sockets",
        argv: ["/bin/sh", "-c", plan.script],
        privileged: true,
        when: plan.repair ? "if-needed" : "always",
      },
    ],
    undo: {
      _tag: "manual",
      detail: "`lando uninstall --purge` removes the helper's units and polkit rule.",
    },
  };
  return {
    change,
    apply: Effect.fnUntraced(function* (steps) {
      const fresh = yield* planSocketHelper(dependencies).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (fresh === undefined) {
        if (yield* isSocketProxyInstalled(dependencies.socketProxy)) return { changed: false };
        return yield* Effect.fail(stale("the helper is no longer needed or can no longer be installed"));
      }
      if (fresh.script !== plan.script)
        return yield* Effect.fail(stale("the hop ports or helper files changed"));
      if (plan.repair && socketsServe(yield* startSockets(dependencies.socketProxy)))
        return { changed: false };
      const outcome = yield* runSocketProxyInstall(steps);
      switch (outcome.kind) {
        case "installed":
          return { changed: true };
        case "foreign":
          return yield* Effect.fail(
            installFailed("The helper's ownership changed while Lando installed it."),
          );
        case "needs-helper":
          return yield* Effect.fail(
            installFailed(
              outcome.reason === "flock-missing"
                ? "Installing the helper needs `flock`, which this host lacks."
                : "A helper file is a symlink, so Lando refused to write it.",
              outcome.exitCode,
              outcome.stderr,
            ),
          );
        case "elevation-refused":
          return yield* Effect.fail(
            installFailed("The helper install script failed.", outcome.exitCode, outcome.stderr),
          );
        default: {
          const exhaustive: never = outcome;
          return exhaustive;
        }
      }
    }),
  };
};
