import type { GpgAgentTransportError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { Effect } from "effect";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import type { GpgAgentIntent } from "../subsystems/gpg-agent/intent.ts";
import { validateGpgAgentOverlay } from "../subsystems/gpg-agent/overlay.ts";
import { validateSshAgentOverlay } from "../subsystems/ssh-agent/overlay.ts";
import type { SshAgentIntent } from "../subsystems/ssh/intent.ts";
import {
  type PreparedDebuggerOverlay,
  prepareDebuggerOverlay,
  projectDebuggerOverlay,
  startOverlayRegistry,
} from "../subsystems/start-overlay-registry.ts";
import { withRetainedAgentOverlays } from "./restart-agent-overlays.ts";
import type { StartManagedScope } from "./start-file-sync.ts";
import { resolveStartGpgAgentIntent } from "./start-gpg-agent-intent.ts";
import { validateGpgAgentSocketCapability, withStartedGpgAgent } from "./start-gpg-agent.ts";
import { validateHostProxyOverlay, withStartedHostProxy } from "./start-host-proxy.ts";
import { resolveStartSshAgentIntent } from "./start-ssh-agent-intent.ts";
import { validateAgentSocketCapability, withStartedSshAgent } from "./start-ssh-agent.ts";

export {
  type PreparedDebuggerOverlay,
  prepareDebuggerOverlay,
  projectDebuggerOverlay,
} from "../subsystems/start-overlay-registry.ts";

export interface PreparedStartOverlays extends PreparedDebuggerOverlay {
  readonly sshIntent: SshAgentIntent;
  readonly gpgIntent: GpgAgentIntent;
}

export const prepareStartOverlays = Effect.fn("StartOverlays.prepare")(function* (
  target: ResolvedAppTarget,
  provider: RuntimeProviderShape,
) {
  const debuggerOverlay = yield* prepareDebuggerOverlay(target.plan);
  const sshIntent = yield* resolveStartSshAgentIntent(target);
  const gpgIntent = yield* resolveStartGpgAgentIntent(target);
  if (target.app.kind !== "global" && target.plan.id !== "global") {
    if (startOverlayRegistry.ssh.eligible(target.plan).length > 0) {
      if (sshIntent.mode === "host") yield* validateAgentSocketCapability(provider.capabilities, sshIntent);
      if (provider.capabilities.agentSocket !== undefined) yield* validateSshAgentOverlay(target.plan);
    }
    if (gpgIntent.forward && startOverlayRegistry.gpg.eligible(target.plan).length > 0) {
      yield* validateGpgAgentSocketCapability(provider.capabilities);
      yield* validateGpgAgentOverlay(target.plan);
    }
    yield* validateHostProxyOverlay(target.plan, provider.capabilities, provider.platform);
  }
  return { ...debuggerOverlay, sshIntent, gpgIntent } satisfies PreparedStartOverlays;
});

export const withAcquiredStartOverlays = <A, E, R>(
  target: ResolvedAppTarget,
  prepared: PreparedStartOverlays,
  options: {
    readonly provider: RuntimeProviderShape;
    readonly managed?: StartManagedScope;
    readonly workerPlan: AppPlan;
    readonly reusePolicy: "exact" | "adopt";
    readonly use: (
      plan: AppPlan,
      afterApply: Effect.Effect<void, GpgAgentTransportError>,
    ) => Effect.Effect<A, E, R>;
  },
) => {
  const { provider, managed } = options;
  return withStartedGpgAgent(target.plan, target.app, provider.capabilities, prepared.gpgIntent, {
    exec: provider.exec,
    ...(managed === undefined ? {} : { managed }),
    use: (gpgPlan, afterApply) =>
      withStartedSshAgent(gpgPlan, target.app, provider.capabilities, prepared.sshIntent, {
        ...(managed === undefined ? {} : { managed }),
        use: (sshPlan) =>
          withStartedHostProxy(sshPlan, target.app, provider.capabilities, {
            platform: provider.platform,
            workerPlan: options.workerPlan,
            reusePolicy: options.reusePolicy,
            ...(managed === undefined ? {} : { managed }),
            use: (plan) => options.use(plan, afterApply),
          }),
      }),
  });
};

export const retainStartOverlays = Effect.fn("StartOverlays.retain")(function* (
  target: Pick<ResolvedAppTarget, "plan" | "app">,
  prepared: PreparedDebuggerOverlay,
) {
  return projectDebuggerOverlay(yield* withRetainedAgentOverlays(target.plan, target.app), prepared);
});
