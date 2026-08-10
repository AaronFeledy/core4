import { Effect } from "effect";

import { ProviderSetupConsentDeniedError } from "@lando/sdk/errors";
import type { ProviderSetupPlan } from "@lando/sdk/schema";
import type { InteractionError, InteractionServiceShape } from "@lando/sdk/services";

interface ProviderSetupAuthorizationOptions {
  readonly yes: boolean;
  readonly nonInteractive: boolean;
  readonly interaction: InteractionServiceShape | undefined;
}

const consentDenied = (plan: ProviderSetupPlan): ProviderSetupConsentDeniedError =>
  new ProviderSetupConsentDeniedError({
    providerId: plan.providerId,
    change: "install-uidmap",
    message: "Installing Ubuntu's uidmap package requires explicit consent.",
    remediation:
      "Rerun `lando setup --yes --no-interactive` to approve this fixed host change, or install uidmap manually.",
  });

export const authorizeProviderSetupPlan = (
  plan: ProviderSetupPlan,
  options: ProviderSetupAuthorizationOptions,
): Effect.Effect<ProviderSetupPlan, ProviderSetupConsentDeniedError | InteractionError> => {
  if (plan.changes.length === 0 || options.yes) return Effect.succeed(plan);
  if (options.nonInteractive || options.interaction === undefined) return Effect.fail(consentDenied(plan));

  return Effect.scoped(
    options.interaction.confirm({
      name: "provider-setup-install-uidmap",
      message: plan.changes[0]?.reason ?? "Allow the planned provider host change?",
      default: false,
    }),
  ).pipe(Effect.flatMap((approved) => (approved ? Effect.succeed(plan) : Effect.fail(consentDenied(plan)))));
};
