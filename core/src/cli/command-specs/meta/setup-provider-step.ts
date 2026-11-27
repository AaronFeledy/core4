/**
 * `meta:setup` provider step: runs the provider's setup with the run's approved host changes,
 * which it applies itself in its own order. Planning, consent, and credentials happened earlier,
 * in `setup-host-changes.ts`. `--skip-provider` records the step as skipped instead.
 */
import { NetworkTrust } from "@lando/http-client/network-trust";
import type {
  HostChangeApplier,
  ProviderSetupInspectOptions,
  RuntimeProviderShape,
} from "@lando/sdk/services";
import { Effect } from "effect";

import { type ResolvedSetupNetworkTrust, networkTrustFromResolved } from "../../commands/setup-network-trust";
import { inputBooleanFlag } from "./setup-inputs";
import { type SetupReadinessRecorder, runtimeServiceReadinessFor } from "./setup-steps";

export interface ProviderSetupStepInput {
  readonly input: unknown;
  readonly provider: RuntimeProviderShape;
  /** The selected provider id as the user chose it. */
  readonly selectedProviderId: string;
  readonly network: ResolvedSetupNetworkTrust;
  readonly inspectOptions: ProviderSetupInspectOptions;
  readonly hostChanges: HostChangeApplier;
  readonly recorder: SetupReadinessRecorder;
}

export const runProviderSetupStep = Effect.fn("SetupCommand.runProviderSetupStep")(function* ({
  input,
  provider,
  selectedProviderId,
  network,
  inspectOptions,
  hostChanges,
  recorder,
}: ProviderSetupStepInput) {
  if (inputBooleanFlag(input, "skip-provider")) {
    yield* recorder.record({
      id: "provider",
      status: "skipped",
      evidence: `Provider ${selectedProviderId} setup skipped by --skip-provider.`,
    });
    return;
  }
  yield* Effect.scoped(provider.setup({ ...inspectOptions, hostChanges })).pipe(
    Effect.provideService(NetworkTrust, networkTrustFromResolved(network)),
    Effect.tapError((cause) => recorder.recordFailure("provider", cause)),
  );
  recorder.setRuntimeService(yield* runtimeServiceReadinessFor(provider));
  yield* recorder.record({
    id: "provider",
    status: "satisfied",
    evidence: `Provider ${selectedProviderId} setup completed.`,
  });
});
