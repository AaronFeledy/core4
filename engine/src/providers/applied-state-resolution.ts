import { isAbsolute, relative } from "node:path";

import { Effect } from "effect";

import { AppResolveError } from "@lando/sdk/errors";
import type { AbsolutePath, AppPlan } from "@lando/sdk/schema";
import type { ProviderError, RuntimeProviderShape } from "@lando/sdk/services";

export type AppliedStateProvider = Pick<RuntimeProviderShape, "id" | "appliedPlans" | "list" | "listVolumes">;

export const resolveAppliedPlanEvidence = (
  root: AbsolutePath,
  providers: ReadonlyArray<AppliedStateProvider>,
): Effect.Effect<AppPlan | undefined, AppResolveError | ProviderError> =>
  Effect.gen(function* () {
    if (providers.length === 0) {
      return yield* Effect.fail(
        new AppResolveError({
          message: "No runtime provider can confirm applied app state.",
          reason: "not-found",
          detail: "provider-evidence",
          remediation: "Install or enable a runtime provider before retrying teardown.",
        }),
      );
    }
    const plans = (yield* Effect.forEach(providers, (provider) =>
      (provider.appliedPlans ?? Effect.succeed([])).pipe(
        Effect.flatMap((appliedPlans) =>
          Effect.forEach(appliedPlans, (plan) =>
            String(plan.provider) === provider.id
              ? Effect.succeed(plan)
              : Effect.fail(
                  new AppResolveError({
                    message: `Provider ${provider.id} supplied applied state attributed to ${plan.provider}.`,
                    reason: "mismatch",
                    detail: "applied-state-provider",
                    remediation: "Remove the mismatched applied state before retrying teardown.",
                  }),
                ),
          ),
        ),
      ),
    )).flat();
    const matches = plans
      .filter((plan) => {
        const appRoot = plan.identity?.appRoot;
        if (appRoot === undefined) return false;
        const child = relative(appRoot, root);
        return child === "" || (!child.startsWith("..") && !isAbsolute(child));
      })
      .sort((left, right) => String(right.identity?.appRoot).length - String(left.identity?.appRoot).length);
    const selected = matches[0];
    if (selected === undefined) {
      const evidence = yield* Effect.forEach(providers, (provider) =>
        Effect.all({ services: provider.list({}), volumes: provider.listVolumes({}) }),
      );
      const services = evidence.flatMap((result) =>
        result.services.filter((service) => service.appRoot === root),
      );
      const ownedVolumes = evidence.flatMap((result) =>
        result.volumes.filter((volume) => volume.identity?.ownerRoot === root),
      );
      if (services.length > 0 || ownedVolumes.length > 0) {
        return yield* Effect.fail(
          new AppResolveError({
            message: "Runtime resources remain without matching applied app state.",
            reason: "mismatch",
            detail: "provider-resources",
            remediation:
              "Restore the matching applied state or remove the orphaned provider resources before retrying teardown.",
          }),
        );
      }
      return undefined;
    }
    const selectedRoot = selected.identity?.appRoot;
    if (matches.some((candidate) => candidate !== selected && candidate.identity?.appRoot === selectedRoot)) {
      return yield* Effect.fail(
        new AppResolveError({
          message: `Multiple providers claim applied state for ${selectedRoot}.`,
          reason: "ambiguous",
          detail: "applied-state",
          remediation: "Remove the conflicting provider state before retrying teardown.",
        }),
      );
    }
    return selected;
  });
