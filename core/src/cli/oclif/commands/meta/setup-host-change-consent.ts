import { Effect } from "effect";

import type { ProviderHostChangeRequest } from "@lando/sdk/services";
import type { InteractionServiceShape } from "@lando/sdk/services";

interface SetupHostChangeConsentOptions {
  readonly yes: boolean;
  readonly nonInteractive: boolean;
  readonly interaction: InteractionServiceShape | undefined;
}

export const makeSetupHostChangeConsent =
  (options: SetupHostChangeConsentOptions) =>
  (request: ProviderHostChangeRequest): Effect.Effect<boolean> => {
    if (options.yes) return Effect.succeed(true);
    const interaction = options.interaction;
    if (options.nonInteractive || interaction === undefined) return Effect.succeed(false);

    const confirm = (message: string): Effect.Effect<boolean> =>
      Effect.scoped(
        interaction.confirm({
          name: "provider-host-change",
          message,
          default: false,
        }),
      ).pipe(Effect.catchAll(() => Effect.succeed(false)));

    switch (request._tag) {
      case "package-install":
        return confirm(`Install host package "${request.packageName}"? ${request.reason}`);
      case "enable-user-linger":
        return confirm(
          `Enable user linger for UID ${request.uid} as an optional persistence convenience? ${request.reason}`,
        );
      default:
        return assertNever(request);
    }
  };

const assertNever = (value: never): never => {
  throw new Error(`Unexpected provider host-change request: ${String(value)}`);
};
