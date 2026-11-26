/**
 * `meta:setup` provider step: checks a system runtime is present, plans the
 * provider's host setup, asks for consent to privileged changes, and applies
 * it. `--skip-provider` records the step as skipped instead.
 */
import { NetworkTrust } from "@lando/http-client/network-trust";
import type { InteractionServiceShape, PrivilegeService, RuntimeProviderShape } from "@lando/sdk/services";
import { type Context, Effect } from "effect";

import { type ResolvedSetupNetworkTrust, networkTrustFromResolved } from "../../commands/setup-network-trust";
import { contributedSetupFlagsForProvider } from "./setup-command-flags";
import { inputBooleanFlag, inputStringFlag } from "./setup-inputs";
import { authorizeProviderSetupPlan, providerSetupChangePurpose } from "./setup-provider-authorization";
import { SYSTEM_RUNTIME_PROVIDERS, systemRuntimeUnavailableError } from "./setup-provider-selection";
import { type SetupReadinessRecorder, runtimeServiceReadinessFor } from "./setup-steps";

export interface ProviderSetupStepInput {
  readonly input: unknown;
  readonly provider: RuntimeProviderShape;
  /** The selected provider id as the user chose it. */
  readonly selectedProviderId: string;
  readonly network: ResolvedSetupNetworkTrust;
  readonly privilegeOptions: { readonly privilege?: Context.Service.Shape<typeof PrivilegeService> };
  readonly interaction: InteractionServiceShape | undefined;
  readonly recorder: SetupReadinessRecorder;
}

export const runProviderSetupStep = Effect.fn("SetupCommand.runProviderSetupStep")(function* ({
  input,
  provider,
  selectedProviderId,
  network,
  privilegeOptions,
  interaction,
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
  const runtimeBundleUrl = inputStringFlag(input, "runtime-bundle-url");
  const runtimeBundleSha256 = inputStringFlag(input, "runtime-bundle-sha256");
  const setupFlags = contributedSetupFlagsForProvider(input, selectedProviderId);
  const inspectOptions = {
    force: false,
    network,
    ...(runtimeBundleUrl === undefined ? {} : { runtimeBundleUrl }),
    ...(runtimeBundleSha256 === undefined ? {} : { runtimeBundleSha256 }),
    ...(Object.keys(setupFlags).length === 0 ? {} : { setupFlags }),
  };
  const plan = yield* provider
    .planSetup(inspectOptions)
    .pipe(Effect.tapError((cause) => recorder.recordFailure("provider", cause)));
  const approvedPlan = yield* authorizeProviderSetupPlan(plan, {
    yes: inputBooleanFlag(input, "yes"),
    nonInteractive: inputBooleanFlag(input, "no-interactive"),
    interaction,
  }).pipe(Effect.tapError((cause) => recorder.recordFailure("provider", cause)));
  // Ask for administrator access once, after consent and before the runtime download and the
  // first privileged change, so a run that cannot get it fails before mutating anything.
  if (approvedPlan.changes.length > 0 && privilegeOptions.privilege !== undefined) {
    yield* privilegeOptions.privilege
      .ensureCredentials(approvedPlan.changes.map(providerSetupChangePurpose).join(", "))
      .pipe(Effect.tapError((cause) => recorder.recordFailure("provider", cause)));
  }
  yield* Effect.scoped(
    provider.setup(approvedPlan, {
      ...inspectOptions,
      ...privilegeOptions,
    }),
  ).pipe(
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
