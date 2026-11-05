import type { AppPlan } from "@lando/sdk/schema";
import { Effect } from "effect";
import { applyDebuggerHost, resolveDebuggerHost, stripDebuggerHost } from "./debugger-host.ts";
import { gpgAgentEligibleServices, stripGpgAgentOverlay, withGpgAgentOverlay } from "./gpg-agent/overlay.ts";
import { stripHostProxyRunLando } from "./host-proxy/transport-feature.ts";
import { hostProxyEligibleServices } from "./host-proxy/worker-service-plan.ts";
import { sshAgentEligibleServices, stripSshAgentOverlay, withSshAgentOverlay } from "./ssh-agent/overlay.ts";

export const startOverlayRegistry = {
  hostProxy: { eligible: hostProxyEligibleServices, strip: stripHostProxyRunLando },
  ssh: { eligible: sshAgentEligibleServices, project: withSshAgentOverlay, strip: stripSshAgentOverlay },
  gpg: { eligible: gpgAgentEligibleServices, project: withGpgAgentOverlay, strip: stripGpgAgentOverlay },
  debugger: { resolve: resolveDebuggerHost, project: applyDebuggerHost, strip: stripDebuggerHost },
} as const;

export const stripStartOverlays = (plan: AppPlan): AppPlan =>
  Object.values(startOverlayRegistry).reduce((current, overlay) => overlay.strip(current), plan);

export interface PreparedDebuggerOverlay {
  readonly debuggerHost: string | undefined;
}

export const prepareDebuggerOverlay = Effect.fn("StartOverlays.prepareDebugger")(function* (plan: AppPlan) {
  return {
    debuggerHost: yield* startOverlayRegistry.debugger.resolve(plan),
  } satisfies PreparedDebuggerOverlay;
});

export const projectDebuggerOverlay = (plan: AppPlan, prepared: PreparedDebuggerOverlay): AppPlan =>
  startOverlayRegistry.debugger.project(plan, prepared.debuggerHost);
