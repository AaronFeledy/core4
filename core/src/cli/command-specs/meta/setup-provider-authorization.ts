import { ProviderSetupConsentDeniedError } from "@lando/sdk/errors";
import type { ProviderSetupHostChange, ProviderSetupPlan } from "@lando/sdk/schema";
import type { InteractionError, InteractionServiceShape } from "@lando/sdk/services";
import { Effect } from "effect";

interface ProviderSetupAuthorizationOptions {
  readonly yes: boolean;
  readonly nonInteractive: boolean;
  readonly interaction: InteractionServiceShape | undefined;
}

/** What core approved, plus separately-consented changes the user did not approve. */
export interface AuthorizedProviderSetupPlan {
  readonly plan: ProviderSetupPlan;
  readonly skipped: ReadonlyArray<ProviderSetupHostChange>;
}

/**
 * Lingering keeps a user manager running across logout and reboot, so it needs its own answer:
 * `--yes` never approves it, only an interactive confirm or the provider's opt-in flag does.
 */
const needsSeparateConsent = (change: ProviderSetupHostChange): boolean => {
  switch (change._tag) {
    case "enable-user-linger":
      return true;
    case "install-uidmap":
    case "provision-subuid":
    case "provision-subgid":
    case "provision-cgroups-delegation":
      return false;
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
};

export const providerSetupChangePurpose = (change: ProviderSetupHostChange): string => {
  switch (change._tag) {
    case "install-uidmap":
      return "install the uidmap package";
    case "provision-subuid":
      return "add subordinate user IDs for your account";
    case "provision-subgid":
      return "add subordinate group IDs for your account";
    case "provision-cgroups-delegation":
      return "let your systemd user manager delegate cgroup controllers";
    case "enable-user-linger":
      return "enable lingering so your systemd user manager runs without a login session";
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
};

/** `lingerPlanned`: lingering is also planned, and `--yes` does not approve it. */
const consentDenied = (plan: ProviderSetupPlan, lingerPlanned: boolean): ProviderSetupConsentDeniedError => {
  const changesList = plan.changes.map((c) => c._tag).join(", ");
  return new ProviderSetupConsentDeniedError({
    providerId: plan.providerId,
    change: plan.changes[0]?._tag ?? "install-uidmap",
    message: `Installing or provisioning prerequisites (${changesList}) requires explicit consent.`,
    remediation: lingerPlanned
      ? "Rerun `lando setup --yes --no-interactive` to approve these privileged host changes; `--yes` does not enable lingering, so add `--enable-linger` to enable it too. Or configure prerequisites manually."
      : "Rerun `lando setup --yes --no-interactive` to approve these privileged host changes, or configure prerequisites manually.",
  });
};

const approveStandard = (
  plan: ProviderSetupPlan,
  lingerPlanned: boolean,
  options: ProviderSetupAuthorizationOptions,
): Effect.Effect<boolean, ProviderSetupConsentDeniedError | InteractionError> => {
  const denied = () => consentDenied(plan, lingerPlanned);
  if (plan.changes.length === 0 || options.yes) return Effect.succeed(true);
  if (options.nonInteractive || options.interaction === undefined) return Effect.fail(denied());
  const changesSummary =
    plan.changes.length === 1
      ? (plan.changes[0]?.reason ?? "Allow the planned provider host change?")
      : `${plan.changes.length} host changes:\n${plan.changes.map((c) => `  - ${c.reason}`).join("\n")}\n\nApprove all changes?`;
  return Effect.scoped(
    options.interaction.confirm({ name: "provider-setup-consent", message: changesSummary, default: false }),
  ).pipe(Effect.flatMap((approved) => (approved ? Effect.succeed(true) : Effect.fail(denied()))));
};

const approveSeparately = (
  change: ProviderSetupHostChange,
  options: ProviderSetupAuthorizationOptions,
): Effect.Effect<boolean, InteractionError> => {
  if (change._tag === "enable-user-linger" && change.optedIn) return Effect.succeed(true);
  // `--yes` asks for no prompts, and it does not approve this change either.
  if (options.yes || options.nonInteractive || options.interaction === undefined)
    return Effect.succeed(false);
  return Effect.scoped(
    options.interaction.confirm({
      name: "provider-setup-linger-consent",
      message: `${change.reason}\nLingering stays enabled after you log out and after a reboot. Enable it?`,
      default: false,
    }),
  );
};

export const authorizeProviderSetupPlan = Effect.fnUntraced(function* (
  plan: ProviderSetupPlan,
  options: ProviderSetupAuthorizationOptions,
): Effect.fn.Return<AuthorizedProviderSetupPlan, ProviderSetupConsentDeniedError | InteractionError> {
  const standard = plan.changes.filter((change) => !needsSeparateConsent(change));
  const lingerPlanned = plan.changes.some((change) => change._tag === "enable-user-linger");
  yield* approveStandard({ ...plan, changes: standard }, lingerPlanned, options);
  const skipped: Array<ProviderSetupHostChange> = [];
  for (const change of plan.changes.filter(needsSeparateConsent)) {
    if (!(yield* approveSeparately(change, options))) skipped.push(change);
  }
  return skipped.length === 0
    ? { plan, skipped }
    : { plan: { ...plan, changes: plan.changes.filter((change) => !skipped.includes(change)) }, skipped };
});
