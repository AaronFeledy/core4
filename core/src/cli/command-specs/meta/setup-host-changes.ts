/**
 * `meta:setup` host-change plan: collect proposals read-only, validate them, report the
 * credentials a run would need, then (for a real run) decide consent, open the run's one
 * administrator session, and hand stages an applier. Nothing here changes the host.
 */
import { makeHostChangeApplier } from "@lando/engine/host-changes/apply";
import { planNeedsPrivilege, validateHostChangePlan } from "@lando/engine/host-changes/plan";
import { MessageWarnEvent } from "@lando/sdk/events";
import type { HostChange, HostChangeId, PrivilegeCredentialStatus } from "@lando/sdk/schema";
import {
  EventService,
  type HostChangeProposal,
  type InteractionServiceShape,
  type PrivilegeService,
  type PrivilegeSession,
  ProcessRunner,
  type ProviderSetupInspectOptions,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { type Context, DateTime, Effect, Option } from "effect";

import { CliInvocation } from "../../../runtime/invocation-context";
import { resolveSecretsRedactor } from "../../commands/secrets-redactor";
import type { ResolvedSetupNetworkTrust } from "../../commands/setup-network-trust";
import { decideHostChangeConsent } from "../../host-changes/consent";
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

export const planSetupHostChanges = Effect.fn("SetupCommand.planHostChanges")(function* (
  plan: SetupHostChangePlanInput,
) {
  const inspectOptions = inspectOptionsFor(plan.input, plan.selectedProviderId, plan.network);
  const proposed = yield* providerProposals({ ...plan, inspectOptions });
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

const publishWarnings = Effect.fnUntraced(function* (warnings: ReadonlyArray<string>) {
  const events = yield* Effect.serviceOption(EventService);
  if (Option.isNone(events)) return;
  for (const body of warnings) {
    yield* events.value
      .publish(MessageWarnEvent.make({ body, timestamp: yield* DateTime.now }))
      .pipe(Effect.ignore);
  }
});

const sessionPurpose = (changes: ReadonlyArray<HostChange>): string =>
  changes.map((change) => change.summary.charAt(0).toLowerCase() + change.summary.slice(1)).join(", ");

/** Whether this run can ask in a terminal; the dry run asks the same of the run it previews. */
export const setupCanAsk = Effect.fnUntraced(function* (
  input: unknown,
  interaction: InteractionServiceShape | undefined,
) {
  if (interaction === undefined || inputBooleanFlag(input, "no-interactive")) return false;
  return yield* interaction.isInteractive;
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
  const canAsk = yield* setupCanAsk(input, interaction);
  const consent = yield* decideHostChangeConsent(plan.changes, {
    yes: inputBooleanFlag(input, "yes"),
    optInFlags: plan.optInFlags,
    interaction: canAsk ? interaction : undefined,
  }).pipe(Effect.tapError((cause) => recorder.recordFailure("provider", cause)));
  yield* publishWarnings(consent.warnings);
  const approvedPrivileged = plan.changes.filter(
    (change) => consent.approved.has(change.id) && change.steps.some((step) => step.privileged),
  );
  let session: PrivilegeSession | undefined;
  if (approvedPrivileged.length > 0 && privilege !== undefined) {
    session = yield* privilege
      .openSession(sessionPurpose(approvedPrivileged))
      .pipe(Effect.tapError((cause) => recorder.recordFailure("provider", cause)));
  }
  const runner = yield* Effect.serviceOption(ProcessRunner);
  const { redact } = yield* resolveSecretsRedactor({ sourceEnv: (yield* CliInvocation).env });
  return makeHostChangeApplier({
    proposals: plan.proposals,
    approved: consent.approved satisfies ReadonlySet<HostChangeId>,
    ...(session === undefined ? {} : { session }),
    ...(Option.isNone(runner) ? {} : { runner: runner.value }),
    redact,
  });
});
