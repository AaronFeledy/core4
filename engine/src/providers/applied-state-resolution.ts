import { isAbsolute, relative } from "node:path";

import { Effect } from "effect";

import { AppResolveError } from "@lando/sdk/errors";
import { type AbsolutePath, type AppPlan, ProviderId } from "@lando/sdk/schema";
import type {
  AppliedOrphanGroup,
  AppliedTeardownEvidence,
  ProviderError,
  RuntimeProviderShape,
} from "@lando/sdk/services";

export type AppliedStateProvider = Pick<
  RuntimeProviderShape,
  "id" | "appliedPlans" | "isAvailable" | "list" | "listVolumes"
>;

const runtimeEvidence = (provider: AppliedStateProvider) =>
  provider.isAvailable.pipe(
    Effect.flatMap((available) =>
      available
        ? Effect.all({ services: provider.list({}), volumes: provider.listVolumes({}) })
        : Effect.succeed({ services: [], volumes: [] }),
    ),
  );

const orphanRefusal = new AppResolveError({
  message: "Runtime resources remain without matching applied app state.",
  reason: "mismatch",
  detail: "provider-resources",
  remediation:
    "Restore the matching applied state or remove the orphaned provider resources before retrying teardown.",
});

/**
 * Groups every runtime resource recorded against `root` by the provider that holds it and the app
 * id it was created for, preserving observation order within each group.
 */
const groupOrphans = (
  root: AbsolutePath,
  providers: ReadonlyArray<AppliedStateProvider>,
  evidence: ReadonlyArray<{
    readonly services: RuntimeEvidence["services"];
    readonly volumes: RuntimeEvidence["volumes"];
  }>,
): ReadonlyArray<AppliedOrphanGroup> => {
  const groups = new Map<
    string,
    {
      readonly providerId: AppliedOrphanGroup["providerId"];
      readonly appId: AppliedOrphanGroup["appId"];
      readonly services: Array<AppliedOrphanGroup["services"][number]>;
      readonly volumes: Array<AppliedOrphanGroup["volumes"][number]>;
    }
  >();
  const groupFor = (providerId: string, appId: AppliedOrphanGroup["appId"]) => {
    const key = `${providerId}\0${appId}`;
    const existing = groups.get(key);
    if (existing !== undefined) return existing;
    const created = { providerId: ProviderId.make(providerId), appId, services: [], volumes: [] };
    groups.set(key, created);
    return created;
  };
  providers.forEach((provider, index) => {
    const observed = evidence[index];
    if (observed === undefined) return;
    for (const service of observed.services) {
      if (service.appRoot !== root) continue;
      groupFor(provider.id, service.app).services.push(service);
    }
    for (const volume of observed.volumes) {
      if (volume.identity?.ownerRoot !== root) continue;
      groupFor(provider.id, volume.ref.app).volumes.push(volume);
    }
  });
  return Array.from(groups.values());
};

type RuntimeEvidence = Effect.Effect.Success<ReturnType<typeof runtimeEvidence>>;

/**
 * Resolves what the providers actually hold for `root`: the applied plan that owns it, the orphaned
 * resources recorded against it, or nothing at all.
 */
const collectEvidence = (
  root: AbsolutePath,
  providers: ReadonlyArray<AppliedStateProvider>,
  ownership: "exact" | "ancestor",
): Effect.Effect<AppliedTeardownEvidence, AppResolveError | ProviderError> =>
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
        if (ownership === "exact") return appRoot === root;
        const child = relative(appRoot, root);
        return child === "" || (!child.startsWith("..") && !isAbsolute(child));
      })
      .sort((left, right) => String(right.identity?.appRoot).length - String(left.identity?.appRoot).length);
    const selected = matches[0];
    if (selected === undefined) {
      const evidence = yield* Effect.forEach(providers, runtimeEvidence);
      const groups = groupOrphans(root, providers, evidence);
      return groups.length > 0 ? { kind: "orphans" as const, groups } : { kind: "absent" as const };
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
    return { kind: "applied" as const, plan: selected };
  });

/**
 * Resolves what the providers hold for a root that teardown has already discovered, so ownership is
 * exact: a nested app root never inherits its parent's applied plan as a teardown target.
 */
export const resolveTeardownEvidence = (
  root: AbsolutePath,
  providers: ReadonlyArray<AppliedStateProvider>,
): Effect.Effect<AppliedTeardownEvidence, AppResolveError | ProviderError> =>
  collectEvidence(root, providers, "exact");

/**
 * Fail-closed applied-state resolution for every non-teardown caller: orphaned runtime resources
 * are a refusal, never a teardown target. Ownership stays ancestor-matched for callers that resolve
 * from an arbitrary working directory.
 */
export const resolveAppliedPlanEvidence = (
  root: AbsolutePath,
  providers: ReadonlyArray<AppliedStateProvider>,
): Effect.Effect<AppPlan | undefined, AppResolveError | ProviderError> =>
  collectEvidence(root, providers, "ancestor").pipe(
    Effect.flatMap((evidence) => {
      switch (evidence.kind) {
        case "applied":
          return Effect.succeed(evidence.plan);
        case "orphans":
          return Effect.fail(orphanRefusal);
        case "absent":
          return Effect.succeed(undefined);
      }
    }),
  );
