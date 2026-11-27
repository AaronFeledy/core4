/**
 * `lando setup --dry-run`: the host changes a real run with the same flags would plan, the approval
 * each would reach without asking, and how it would get administrator access. It changes nothing:
 * no question, readiness record, configuration, provider switch, download, or session.
 */
import { previewApprovals } from "@lando/engine/host-changes/plan";
import { HostProviderOverride } from "@lando/engine/providers/host-provider";
import type { GlobalConfig, ProviderId } from "@lando/sdk/schema";
import type {
  HostChangeProposal,
  InteractionServiceShape,
  PrivilegeService,
  RuntimeProviderShape,
} from "@lando/sdk/services";
import { type Context, Effect } from "effect";

import { resolveSetupNetworkTrust } from "../../commands/setup-network-trust";
import { planSetupHostChanges, setupCanAsk } from "./setup-host-changes";
import { type SetupResult, inputBooleanFlag } from "./setup-inputs";
import type { SetupReadinessRecorder } from "./setup-steps";

const DRY_RUN_NOTICES = ["The network trust probe was skipped."];

export interface SetupDryRunInput {
  readonly input: unknown;
  readonly globalConfig: GlobalConfig;
  readonly provider: RuntimeProviderShape;
  readonly selectedProvider: ProviderId;
  readonly selectionSource: Extract<SetupResult, { readonly dryRun: true }>["selectionSource"];
  readonly privilege: Context.Service.Shape<typeof PrivilegeService> | undefined;
  readonly recorder: SetupReadinessRecorder;
  readonly rootRepair: HostChangeProposal | undefined;
  /** The run's terminal questions, so the preview decides as a real run in this terminal would. */
  readonly interaction: InteractionServiceShape | undefined;
}

export const planSetupDryRun = Effect.fn("SetupCommand.dryRun")(function* (dryRun: SetupDryRunInput) {
  // The live trust probe is the one network call setup makes before changing anything.
  const network = yield* resolveSetupNetworkTrust(dryRun.globalConfig);
  const plan = yield* planSetupHostChanges({
    input: dryRun.input,
    provider: dryRun.provider,
    selectedProviderId: String(dryRun.selectedProvider),
    network,
    privilege: dryRun.privilege,
    recorder: dryRun.recorder,
    rootRepair: dryRun.rootRepair,
  }).pipe(Effect.provideService(HostProviderOverride, dryRun.selectedProvider));
  return {
    dryRun: true,
    providerId: dryRun.provider.id,
    selectionSource: dryRun.selectionSource,
    elevation: plan.elevation,
    changes: previewApprovals(plan.changes, {
      yes: inputBooleanFlag(dryRun.input, "yes"),
      optInFlags: plan.optInFlags,
      canAsk: yield* setupCanAsk(dryRun.input, dryRun.interaction),
    }),
    notices: DRY_RUN_NOTICES,
  } satisfies SetupResult;
});
