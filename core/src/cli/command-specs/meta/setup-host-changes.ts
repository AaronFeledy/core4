/**
 * `meta:setup` host-change plan: collect proposals read-only, validate them, report the
 * credentials a run would need, then (for a real run) decide consent, open the run's one
 * administrator session, and hand stages an applier. Nothing here changes the host.
 */
import { resolveProxyDefaultDomain } from "@lando/engine/config/proxy-default-domain";
import { resolveRouterConfigForApp } from "@lando/engine/config/router-config";
import { planNeedsPrivilege, validateHostChangePlan } from "@lando/engine/host-changes/plan";
import { unavailableRouterReason } from "@lando/engine/subsystems/proxy/api";
import type { HostChange, PrivilegeCredentialStatus } from "@lando/sdk/schema";
import {
  type HostChangeProposal,
  type InteractionServiceShape,
  type PrivilegeService,
  type ProviderSetupInspectOptions,
  RouterService,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { type Context, Effect, Option } from "effect";

import type { ResolvedSetupNetworkTrust } from "../../commands/setup-network-trust";
import { approveHostChanges, askingInteraction } from "../../host-changes/approve";
import {
  contributedSetupFlagNamesForProvider,
  contributedSetupFlagsForProvider,
} from "./setup-command-flags";
import { inputBooleanFlag, inputStringFlag } from "./setup-inputs";
import { SYSTEM_RUNTIME_PROVIDERS, systemRuntimeUnavailableError } from "./setup-provider-selection";
import type { SetupReadinessRecorder } from "./setup-steps";

type PrivilegeShape = Context.Service.Shape<typeof PrivilegeService>;

export interface SetupHostChangePlan {
  readonly proposals: ReadonlyArray<HostChangeProposal>;
  readonly changes: ReadonlyArray<HostChange>;
  /** How a real run would get administrator access. */
  readonly elevation: PrivilegeCredentialStatus;
  readonly inspectOptions: ProviderSetupInspectOptions;
  /** Opt-in flags the run was given (`--enable-linger`). */
  readonly optInFlags: ReadonlySet<string>;
}

export interface SetupHostChangePlanInput {
  readonly input: unknown;
  readonly provider: RuntimeProviderShape;
  readonly selectedProviderId: string;
  readonly network: ResolvedSetupNetworkTrust;
  readonly privilege: PrivilegeShape | undefined;
  readonly recorder: SetupReadinessRecorder;
}

const inspectOptionsFor = (
  input: unknown,
  selectedProviderId: string,
  network: ResolvedSetupNetworkTrust,
) => {
  const runtimeBundleUrl = inputStringFlag(input, "runtime-bundle-url");
  const runtimeBundleSha256 = inputStringFlag(input, "runtime-bundle-sha256");
  const setupFlags = contributedSetupFlagsForProvider(input, selectedProviderId);
  return {
    force: false,
    network,
    ...(runtimeBundleUrl === undefined ? {} : { runtimeBundleUrl }),
    ...(runtimeBundleSha256 === undefined ? {} : { runtimeBundleSha256 }),
    ...(Object.keys(setupFlags).length === 0 ? {} : { setupFlags }),
  } satisfies ProviderSetupInspectOptions;
};

const providerProposals = Effect.fnUntraced(function* ({
  input,
  provider,
  selectedProviderId,
  inspectOptions,
  recorder,
}: Omit<SetupHostChangePlanInput, "network" | "privilege"> & {
  readonly inspectOptions: ProviderSetupInspectOptions;
}) {
  if (inputBooleanFlag(input, "skip-provider")) return [];
  if (selectedProviderId in SYSTEM_RUNTIME_PROVIDERS) {
    const available = yield* provider.isAvailable.pipe(
      Effect.tapError((cause) => recorder.recordFailure("provider", cause)),
    );
    if (!available) {
      const error = systemRuntimeUnavailableError(selectedProviderId);
      yield* recorder.recordFailure("provider", error);
      return yield* Effect.fail(error);
    }
  }
  if (provider.planHostChanges === undefined) return [];
  return yield* provider
    .planHostChanges(inspectOptions)
    .pipe(Effect.tapError((cause) => recorder.recordFailure("provider", cause)));
});

/** The router's helper, planned read-only with the configured ports; an unavailable router plans nothing. */
const routerProposals = Effect.fnUntraced(function* (
  input: unknown,
  recorder: SetupReadinessRecorder,
): Effect.fn.Return<ReadonlyArray<HostChangeProposal>, unknown> {
  if (inputBooleanFlag(input, "skip-proxy")) return [];
  const router = yield* Effect.serviceOption(RouterService);
  if (Option.isNone(router) || router.value.planHostChanges === undefined) return [];
  if (unavailableRouterReason(router.value) !== undefined) return [];
  const defaultDomain = yield* resolveProxyDefaultDomain;
  const { router: ports, routerPin } = yield* resolveRouterConfigForApp();
  return yield* router.value
    .planHostChanges({ defaultDomain, router: ports, routerPin })
    .pipe(Effect.tapError((cause) => recorder.recordFailure("proxy", cause)));
});

export const planSetupHostChanges = Effect.fn("SetupCommand.planHostChanges")(function* (
  plan: SetupHostChangePlanInput,
) {
  const inspectOptions = inspectOptionsFor(plan.input, plan.selectedProviderId, plan.network);
  const proposed = [
    ...(yield* providerProposals({ ...plan, inspectOptions })),
    ...(yield* routerProposals(plan.input, plan.recorder)),
  ];
  const declaredFlags = new Set(contributedSetupFlagNamesForProvider(plan.selectedProviderId));
  const proposals = yield* validateHostChangePlan(proposed, { setupFlags: declaredFlags }).pipe(
    Effect.tapError((cause) => plan.recorder.recordFailure("provider", cause)),
  );
  const changes = proposals.map(({ change }) => change);
  let elevation: PrivilegeCredentialStatus = { state: "not-needed" };
  if (planNeedsPrivilege(changes)) {
    elevation =
      plan.privilege === undefined
        ? { state: "unavailable", detail: "No administrator access service is available to this run." }
        : yield* plan.privilege.credentialStatus;
  }
  const given = inspectOptions.setupFlags ?? {};
  const optInFlags = new Set(Object.keys(given).filter((name) => given[name] === true));
  return { proposals, changes, elevation, inspectOptions, optInFlags } satisfies SetupHostChangePlan;
});

/** Whether this run can ask in a terminal; the dry run asks the same of the run it previews. */
export const setupCanAsk = Effect.fnUntraced(function* (
  input: unknown,
  interaction: InteractionServiceShape | undefined,
) {
  return (yield* askingInteraction(interaction, inputBooleanFlag(input, "no-interactive"))) !== undefined;
});

export interface SetupHostChangeApproval {
  readonly plan: SetupHostChangePlan;
  readonly input: unknown;
  readonly interaction: InteractionServiceShape | undefined;
  readonly privilege: PrivilegeShape | undefined;
  readonly recorder: SetupReadinessRecorder;
}

/**
 * Consent first, then the run's administrator session, both before the first change and before
 * any download: a run that cannot get approval or credentials fails having changed nothing.
 */
export const approveSetupHostChanges = Effect.fn("SetupCommand.approveHostChanges")(function* ({
  plan,
  input,
  interaction,
  privilege,
  recorder,
}: SetupHostChangeApproval) {
  return yield* approveHostChanges({
    command: "setup",
    proposals: plan.proposals,
    yes: inputBooleanFlag(input, "yes"),
    optInFlags: plan.optInFlags,
    interaction: yield* askingInteraction(interaction, inputBooleanFlag(input, "no-interactive")),
    privilege,
  }).pipe(Effect.tapError((cause) => recorder.recordFailure("provider", cause)));
});
