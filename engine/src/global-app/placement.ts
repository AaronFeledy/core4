import { AppPlacementError, GlobalAppError } from "@lando/sdk/errors";
import { GlobalAppService } from "@lando/sdk/services";
import { Effect } from "effect";
import { ensureAppPlacement, resolveAppPlacement } from "../providers/app-placement.ts";
import { hostProviderSelection } from "../providers/host-provider.ts";
import { taggedErrorRemediation } from "../providers/managed.ts";

const globalPlacementInput = Effect.gen(function* () {
  const selection = yield* hostProviderSelection;
  const globalApp = yield* GlobalAppService;
  const app = { kind: "global" as const, id: "global", root: (yield* globalApp.paths).root };
  return { selection, app };
});

export const resolveGlobalPlacement = Effect.fn("GlobalApp.resolvePlacement")(function* () {
  const { selection, app } = yield* globalPlacementInput;
  return { ...(yield* resolveAppPlacement(app, selection.providerId)), selection };
});

export const globalCreateProviderId = Effect.fn("GlobalApp.createProviderId")(
  function* () {
    const { selection, app } = yield* globalPlacementInput;
    return yield* ensureAppPlacement(app, selection.providerId).pipe(
      Effect.mapError((error) =>
        error instanceof AppPlacementError && selection.source === "env"
          ? new AppPlacementError({
              app: error.app,
              message: error.message,
              desiredProviderId: error.desiredProviderId,
              realizedProviderId: error.realizedProviderId,
              remediation: `${error.remediation} Unset \`LANDO_PROVIDER\` before keeping the old provider.`,
            })
          : error,
      ),
    );
  },
  Effect.mapError(
    (cause) =>
      new GlobalAppError({
        message: "Unable to resolve global app placement.",
        operation: "placement",
        remediation: taggedErrorRemediation(cause),
        cause,
      }),
  ),
);

export const globalObserveProviderId = resolveGlobalPlacement().pipe(
  Effect.map(({ desired, realized }) => realized ?? desired),
);
