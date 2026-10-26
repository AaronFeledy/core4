import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import { Effect } from "effect";

import { AppResolveError, ProviderUnavailableError } from "@lando/sdk/errors";
import {
  type AbsolutePath,
  type AppPlan,
  type AppRef,
  ProviderId,
  type ResourceOwnership,
  appIdentityKey,
} from "@lando/sdk/schema";
import type {
  AppliedOrphanGroup,
  AppliedTeardownEvidence,
  ListFilter,
  ProviderError,
  ProviderRuntimeSnapshot,
  RuntimeProviderShape,
} from "@lando/sdk/services";
import { matchesAppPlanIdentity } from "./app-plan-identity.ts";

export type AppliedStateProvider = Pick<
  RuntimeProviderShape,
  "id" | "appliedPlans" | "isAvailable" | "list" | "listVolumes"
> & {
  readonly resourceOwnership?: (
    root: AbsolutePath,
  ) => Effect.Effect<ResourceOwnership | undefined, ProviderUnavailableError>;
  readonly canCleanupOwnedResources?: Effect.Effect<boolean, ProviderError>;
};

const runtimeEvidence = (provider: AppliedStateProvider, filter: ListFilter) =>
  provider.isAvailable.pipe(
    Effect.flatMap((available) =>
      available
        ? Effect.all({
            runtimeObserved: Effect.succeed(true),
            services: provider.list(filter),
            volumes: provider.listVolumes({}),
          })
        : Effect.succeed({ runtimeObserved: false, services: [], volumes: [] }),
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

type RuntimeEvidence = Effect.Success<ReturnType<typeof runtimeEvidence>>;

const canonicalPath = (path: string): Effect.Effect<string> =>
  Effect.tryPromise(() => realpath(path)).pipe(
    Effect.catch(() =>
      Effect.logDebug("applied-state canonicalPath falling back to lexical path").pipe(
        Effect.annotateLogs({ path }),
        Effect.as(path),
      ),
    ),
  );

const isSameOrDescendantPath = (ancestor: string, candidate: string): boolean => {
  const child = relative(ancestor, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
};

const gatherAppliedPlans = (provider: AppliedStateProvider) =>
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
  );

export const observeProviderRuntime = (
  providers: ReadonlyArray<AppliedStateProvider>,
): Effect.Effect<ReadonlyArray<ProviderRuntimeSnapshot>, AppResolveError | ProviderError> =>
  Effect.forEach(providers, (provider) =>
    Effect.gen(function* () {
      const appliedPlans = yield* gatherAppliedPlans(provider);
      const runtime = yield* runtimeEvidence(provider, { includeUnplanned: true });
      return { providerId: ProviderId.make(provider.id), appliedPlans, ...runtime };
    }),
  );

/**
 * Resolves what the providers actually hold for `root`: the applied plan that owns it, the orphaned
 * resources recorded against it, or nothing at all.
 */
const collectEvidence = Effect.fn("RuntimeProviderRegistry.collectEvidence")(function* (
  root: AbsolutePath,
  providers: ReadonlyArray<AppliedStateProvider>,
  ownership: "exact" | "ancestor",
  app: Pick<AppRef, "kind" | "id"> = { kind: "user", id: "" },
): Effect.fn.Return<AppliedTeardownEvidence, AppResolveError | ProviderError> {
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
  const lookupRoot = yield* canonicalPath(root);
  const plans = (yield* Effect.forEach(providers, gatherAppliedPlans)).flat();
  const belongsToApp = (providerId: string, appId: string) => {
    const plan = plans.find(
      (candidate) =>
        candidate.provider === providerId &&
        candidate.id === appId &&
        candidate.identity?.appRoot === lookupRoot,
    );
    return plan === undefined
      ? app.kind !== "scratch" || app.id === appId
      : matchesAppPlanIdentity(plan, app);
  };
  const readOwnership = Effect.gen(function* () {
    const rawInventories = yield* Effect.forEach(
      providers,
      (provider) => provider.resourceOwnership?.(root) ?? Effect.succeed(undefined),
    );
    for (const [index, hints] of rawInventories.entries()) {
      if (hints === undefined) continue;
      const provider = providers[index];
      if (
        provider === undefined ||
        hints.appRoot !== lookupRoot ||
        hints.ownerKey !== appIdentityKey("owner", lookupRoot) ||
        hints.providerId !== provider.id
      )
        return yield* Effect.fail(orphanRefusal);
    }
    const inventories = rawInventories.map((hints): ResourceOwnership | undefined => {
      if (hints === undefined) return undefined;
      const appIds = hints.appIds.filter((id) => belongsToApp(hints.providerId, id));
      return appIds.length === 0 ? undefined : { ...hints, appIds };
    });
    const ownershipHints = inventories.filter((item): item is ResourceOwnership => item !== undefined);
    if (ownership === "exact")
      for (const [index, hints] of inventories.entries()) {
        if (hints === undefined) continue;
        const provider = providers[index];
        if (
          provider === undefined ||
          !(yield* provider.isAvailable) ||
          !(yield* provider.canCleanupOwnedResources ?? Effect.succeed(false))
        )
          return yield* Effect.fail(
            new ProviderUnavailableError({
              providerId: hints.providerId,
              operation: "resource-ownership",
              message: "Owned resource cleanup requires an available, cleanup-capable provider.",
              remediation: "Restore the provider runtime and cleanup capability, then retry teardown.",
            }),
          );
      }
    return ownershipHints;
  });
  const teardownOwnership = ownership === "exact" ? yield* readOwnership : [];
  const matches = (yield* Effect.forEach(plans, (plan) =>
    Effect.gen(function* () {
      if (!matchesAppPlanIdentity(plan, app)) return undefined;
      const appRoot = plan.identity?.appRoot;
      if (appRoot === undefined) return undefined;
      const canonicalAppRoot = yield* canonicalPath(appRoot);
      if (ownership === "exact") return canonicalAppRoot === lookupRoot ? plan : undefined;
      return isSameOrDescendantPath(canonicalAppRoot, lookupRoot) ? plan : undefined;
    }),
  ))
    .filter((plan): plan is AppPlan => plan !== undefined)
    .sort((left, right) => String(right.identity?.appRoot).length - String(left.identity?.appRoot).length);
  const selected = matches[0];
  const selectedRoot = selected?.identity?.appRoot;
  if (
    selected !== undefined &&
    matches.some((candidate) => candidate !== selected && candidate.identity?.appRoot === selectedRoot)
  ) {
    return yield* Effect.fail(
      new AppResolveError({
        message: `Multiple providers claim applied state for ${selectedRoot}.`,
        reason: "ambiguous",
        detail: "applied-state",
        remediation: `From ${selectedRoot}, remove unwanted realizations with ${[...new Set(matches.map((plan) => plan.provider))].map((id) => `\`lando destroy --provider=${id} --yes\``).join(" or ")}, then retry.`,
      }),
    );
  }
  if (ownership === "ancestor" && selected !== undefined) return { kind: "applied", plan: selected };
  const ownershipHints = ownership === "ancestor" ? yield* readOwnership : teardownOwnership;
  const owned = ownershipHints.length === 0 ? {} : { ownership: ownershipHints };
  if (selected === undefined) {
    const evidence = yield* Effect.forEach(providers, (provider) =>
      runtimeEvidence(provider, ownership === "exact" ? { includeUnplanned: true } : {}),
    );
    const groups = groupOrphans(root, providers, evidence).filter((group) =>
      belongsToApp(group.providerId, group.appId),
    );
    return groups.length > 0
      ? { kind: "orphans" as const, groups, ...owned }
      : ownershipHints.length > 0
        ? { kind: "owned", ownership: ownershipHints }
        : { kind: "absent" as const };
  }
  return { kind: "applied" as const, plan: selected, ...owned };
});

/**
 * Resolves what the providers hold for a root that teardown has already discovered, so ownership is
 * exact: a nested app root never inherits its parent's applied plan as a teardown target.
 */
export const resolveTeardownEvidence = (
  root: AbsolutePath,
  providers: ReadonlyArray<AppliedStateProvider>,
  app?: Pick<AppRef, "kind" | "id">,
): Effect.Effect<AppliedTeardownEvidence, AppResolveError | ProviderError> =>
  collectEvidence(root, providers, "exact", app);

/**
 * Fail-closed applied-state resolution for every non-teardown caller: orphaned runtime resources
 * are a refusal, never a teardown target. Ownership stays ancestor-matched for callers that resolve
 * from an arbitrary working directory.
 */
export const resolveAppliedPlanEvidence = (
  root: AbsolutePath,
  providers: ReadonlyArray<AppliedStateProvider>,
  app?: Pick<AppRef, "kind" | "id">,
): Effect.Effect<AppPlan | undefined, AppResolveError | ProviderError> =>
  collectEvidence(root, providers, "ancestor", app).pipe(
    Effect.flatMap((evidence) => {
      switch (evidence.kind) {
        case "applied":
          return Effect.succeed(evidence.plan);
        case "orphans":
        case "owned":
          return Effect.fail(orphanRefusal);
        case "absent":
          return Effect.succeed(undefined);
      }
    }),
  );
