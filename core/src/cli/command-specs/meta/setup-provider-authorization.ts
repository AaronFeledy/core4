import { Effect } from "effect";

import { ProviderSetupConsentDeniedError } from "@lando/sdk/errors";
import type { ProviderSetupPlan } from "@lando/sdk/schema";
import type { InteractionError, InteractionServiceShape } from "@lando/sdk/services";

interface ProviderSetupAuthorizationOptions {
  readonly yes: boolean;
  readonly nonInteractive: boolean;
  readonly interaction: InteractionServiceShape | undefined;
}

const consentDenied = (plan: ProviderSetupPlan): ProviderSetupConsentDeniedError => {
  const changesList = plan.changes.map((c) => c._tag).join(", ");
  return new ProviderSetupConsentDeniedError({
    providerId: plan.providerId,
    change: plan.changes[0]?._tag ?? "install-uidmap",
    message: `Installing or provisioning prerequisites (${changesList}) requires explicit consent.`,
    remediation:
      "Rerun `lando setup --yes --no-interactive` to approve these privileged host changes, or configure prerequisites manually.",
  });
};

export const authorizeProviderSetupPlan = (
  plan: ProviderSetupPlan,
  options: ProviderSetupAuthorizationOptions,
): Effect.Effect<ProviderSetupPlan, ProviderSetupConsentDeniedError | InteractionError> => {
  if (plan.changes.length === 0 || options.yes) return Effect.succeed(plan);
  if (options.nonInteractive || options.interaction === undefined) return Effect.fail(consentDenied(plan));

  const changesSummary =
    plan.changes.length === 1
      ? (plan.changes[0]?.reason ?? "Allow the planned provider host change?")
      : `${plan.changes.length} host changes:\n${plan.changes.map((c) => `  - ${c.reason}`).join("\n")}\n\nApprove all changes?`;

  return Effect.scoped(
    options.interaction.confirm({
      name: "provider-setup-consent",
      message: changesSummary,
      default: false,
    }),
  ).pipe(Effect.flatMap((approved) => (approved ? Effect.succeed(plan) : Effect.fail(consentDenied(plan)))));
};
