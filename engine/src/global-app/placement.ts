import { AppResolveError, GlobalAppError, GlobalAppPlacementError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { GlobalAppService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { canonicalMissingAppRoot } from "../operations/app-mutation-lock.ts";
import { type HostProviderSelection, hostProviderSelection } from "../providers/host-provider.ts";
import { taggedErrorRemediation } from "../providers/managed.ts";

const placementFailure = (cause: unknown) =>
  new GlobalAppError({
    message: "Unable to resolve global app placement.",
    operation: "placement",
    remediation: taggedErrorRemediation(cause),
    cause,
  });

/** Applied plans alone claim placement; ownership inventories do not. Never probes a runtime. */
export const resolveGlobalPlacement = Effect.fn("GlobalApp.resolvePlacement")(function* () {
  const selection = yield* hostProviderSelection;
  const desired = selection.providerId;
  const globalApp = yield* GlobalAppService;
  // Applied plans record the canonical root, so a symlinked data root must resolve before comparing.
  const root = yield* canonicalMissingAppRoot((yield* globalApp.paths).root);
  const registry = yield* RuntimeProviderRegistry;
  if (registry.appliedPlansFor === undefined)
    return yield* Effect.fail(
      new GlobalAppError({
        message: "The runtime provider registry cannot query global app placement.",
        operation: "placement",
        remediation: "Use a runtime provider registry that implements filesystem-only applied plan queries.",
      }),
    );
  const plans = yield* registry.appliedPlansFor(AbsolutePath.make(root));
  const providers = [...new Set(plans.map((plan) => plan.provider))];
  if (plans.length > 1)
    return yield* Effect.fail(
      new AppResolveError({
        message: `The global app has multiple applied plans on providers: ${providers.join(", ")}.`,
        reason: "ambiguous",
        detail: "provider-resources",
        remediation:
          "Remove the duplicate global app realization on its original runtime before retrying. Do not start another global app.",
      }),
    );
  return { desired, selection, realized: providers[0], plan: plans[0] };
});

const keepRealizedRemediation = (selection: HostProviderSelection, realized: string): string =>
  selection.source === "env"
    ? `To keep it on ${realized}, unset \`LANDO_PROVIDER\` (it selects ${selection.providerId}) and run \`lando setup --provider=${realized}\`.`
    : `To keep it on ${realized}, run \`lando setup --provider=${realized}\`.`;

export const globalCreateProviderId = Effect.fn("GlobalApp.createProviderId")(function* () {
  const { desired, selection, realized } = yield* resolveGlobalPlacement();
  if (realized !== undefined && realized !== desired)
    return yield* Effect.fail(
      new GlobalAppPlacementError({
        desiredProviderId: desired,
        realizedProviderId: realized,
        message: `The global app runs on ${realized}, but the host provider is ${desired}.`,
        remediation: `Stop apps that use the router, run \`lando global:destroy --yes\` to remove the global app from ${realized}, then retry. ${keepRealizedRemediation(selection, realized)}`,
      }),
    );
  return desired;
}, Effect.mapError(placementFailure));

export const globalObserveProviderId = resolveGlobalPlacement().pipe(
  Effect.map(({ desired, realized }) => realized ?? desired),
);
