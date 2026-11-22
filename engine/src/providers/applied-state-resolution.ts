import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { inventoryProtectsApp, protectedSlotError } from "@lando/container-runtime/applied-state";
import { AppResolveError, AppliedStateVersionError, ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type AppId,
  type AppPlan,
  type AppRef,
  type AppliedStateInventory,
  ProviderId,
  type ResourceOwnership,
  appIdentityKey,
} from "@lando/sdk/schema";
import type {
  AppliedOrphanGroup,
  AppliedPlanLookup,
  AppliedTeardownEvidence,
  ListFilter,
  ProviderError,
  ProviderRuntimeSnapshot,
  RuntimeProviderShape,
} from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { matchesAppPlanIdentity } from "./app-plan-identity.ts";
import { refuseContradictoryOrphans } from "./orphan-ownership-refusal.ts";

export type AppliedStateProvider = Pick<
  RuntimeProviderShape,
  "id" | "appliedPlans" | "list" | "listVolumes"
> & {
  readonly isAvailable: Effect.Effect<boolean, ProviderError>;
  readonly appliedStateInventory?: Effect.Effect<AppliedStateInventory, ProviderError>;
  readonly readAppliedPlanStrict?: (id: AppId) => Effect.Effect<AppPlan | undefined, ProviderError>;
  readonly journalSlots?: (
    root: AbsolutePath,
  ) => Effect.Effect<readonly { readonly provider: string; readonly id: AppId }[]>;
  readonly resourceOwnership?: (
    root: AbsolutePath,
  ) => Effect.Effect<ResourceOwnership | undefined, ProviderUnavailableError>;
  readonly canCleanupOwnedResources?: Effect.Effect<boolean, ProviderError>;
  readonly runtimeOnline?: Effect.Effect<boolean, ProviderError>;
};

const emptyInventory: AppliedStateInventory = { plans: [], unreadable: [] };

const runtimeEvidence = (provider: AppliedStateProvider, filter: ListFilter, teardown = false) => {
  const online = provider.runtimeOnline ?? provider.isAvailable;
  return (teardown ? online : online.pipe(Effect.catch(() => Effect.succeed(false)))).pipe(
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
};

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

const gatherProviderInventory = (provider: AppliedStateProvider) =>
  (
    provider.appliedStateInventory ??
    (provider.appliedPlans ?? Effect.succeed([])).pipe(Effect.map((plans) => ({ ...emptyInventory, plans })))
  ).pipe(
    Effect.flatMap((inventory) =>
      Effect.forEach(inventory.plans, (plan) =>
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
      ).pipe(Effect.map((plans) => ({ ...inventory, plans }))),
    ),
  );

const isToleratedAppliedStateObservationFailure = (error: unknown): boolean =>
  (error instanceof ProviderUnavailableError || error instanceof AppliedStateVersionError) &&
  (error.operation === "applied-state.read" ||
    error.operation === "applied-state.list" ||
    error.operation.startsWith("applied-state."));

export const observeProviderRuntime = (
  providers: ReadonlyArray<AppliedStateProvider>,
): Effect.Effect<ReadonlyArray<ProviderRuntimeSnapshot>, AppResolveError | ProviderError> =>
  Effect.forEach(providers, (provider) =>
    Effect.gen(function* () {
      // An unreadable or newer receipt is unknown for observation, never absence for teardown.
      const appliedPlans = yield* gatherProviderInventory(provider).pipe(
        Effect.map((inventory) => inventory.plans),
        Effect.catchIf(isToleratedAppliedStateObservationFailure, () => Effect.succeed([])),
      );
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
  ownership: AppliedPlanLookup,
  app: Pick<AppRef, "kind" | "id"> = { kind: "user", id: "" },
  teardown = false,
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
  const lookupRoot = AbsolutePath.make(yield* canonicalPath(root));
  const inventories = yield* Effect.forEach(providers, (provider) =>
    gatherProviderInventory(provider).pipe(
      Effect.map((inventory) => ({ ...inventory, providerId: provider.id })),
    ),
  );
  const plans = inventories.flatMap((inventory) => inventory.plans);
  const selectPlan = Effect.gen(function* () {
    const matches = plans
      .filter((plan) => {
        const appRoot = plan.identity?.appRoot;
        if (appRoot === undefined || !matchesAppPlanIdentity(plan, app)) return false;
        return ownership === "exact" ? appRoot === lookupRoot : isSameOrDescendantPath(appRoot, lookupRoot);
      })
      .sort((left, right) => String(right.identity?.appRoot).length - String(left.identity?.appRoot).length);
    const selected = matches[0];
    if (selected === undefined) return;
    const selectedRoot = selected.identity?.appRoot;
    const sameRoot = matches.filter((plan) => plan.identity?.appRoot === selectedRoot);
    if (sameRoot.length === 1) return selected;
    const providerIds = [...new Set(sameRoot.map((plan) => plan.provider))];
    const renamed = app.kind === "user" && providerIds.length === 1;
    const named =
      renamed && new Set(sameRoot.map((plan) => plan.id)).size === sameRoot.length
        ? sameRoot.find((plan) => plan.id === app.id)
        : undefined;
    if (named !== undefined) return named;
    return yield* Effect.fail(
      new AppResolveError({
        message: renamed
          ? `App folder ${selectedRoot} has multiple applied app names: ${sameRoot.map((plan) => plan.name).join(", ")}.`
          : `Multiple providers claim applied state for ${selectedRoot}: ${providerIds.join(", ")}.`,
        reason: "ambiguous",
        detail: "applied-state",
        remediation: renamed
          ? `Run \`lando start\`, \`lando stop\`, or \`lando destroy\` in ${selectedRoot} to reconcile the app names its Landofile no longer selects.`
          : `From ${selectedRoot}, remove unwanted realizations with ${providerIds.map((id) => `\`lando destroy --provider=${id} --yes\``).join(" or ")}, then retry.`,
      }),
    );
  });
  if (!teardown) {
    const plan = yield* selectPlan;
    // This lookup uses only the selected plan. Decisions about other slots belong to
    // teardown, activation reconciliation, and placement.
    if (plan !== undefined) return { kind: "applied", plan };
  }

  // Always retain inventory issues (including teardown): match against known ids / provider scope
  // before orphan classification. Never infer a root from an unreadable filename.
  const isProtected = (providerId: string, appId: string) =>
    inventories
      .find((inventory) => inventory.providerId === providerId)
      ?.unreadable.some((entry) => inventoryProtectsApp(entry, appId)) === true;
  const readProtected = Effect.fnUntraced(function* (providerId: string, id: AppId) {
    const entry = inventories
      .find((item) => item.providerId === providerId)
      ?.unreadable.find((issue) => inventoryProtectsApp(issue, id));
    if (entry === undefined) return;
    yield* providers.find((provider) => provider.id === providerId)?.readAppliedPlanStrict?.(id) ??
      Effect.void;
    return yield* Effect.fail(protectedSlotError(providerId, entry, id));
  });
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
      (provider) => provider.resourceOwnership?.(lookupRoot) ?? Effect.succeed(undefined),
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
    return ownershipHints;
  });
  if (inventories.some((inventory) => inventory.unreadable.length > 0)) {
    const pending = yield* providers[0]?.journalSlots?.(lookupRoot) ?? Effect.succeed([]);
    for (const slot of pending) {
      if (isProtected(slot.provider, slot.id) && belongsToApp(slot.provider, slot.id))
        yield* readProtected(slot.provider, slot.id);
    }
  }
  const ownershipHints = yield* readOwnership;
  for (const hints of ownershipHints) {
    for (const id of hints.appIds) yield* readProtected(hints.providerId, id);
  }
  const requireOwnershipRuntime = Effect.gen(function* () {
    if (teardown)
      for (const hints of ownershipHints) {
        const provider = providers.find((candidate) => candidate.id === hints.providerId);
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
  });
  const selected = teardown ? yield* selectPlan : undefined;
  const owned = ownershipHints.length === 0 ? {} : { ownership: ownershipHints };
  const protectedProviders = new Set(
    inventories
      .filter((inventory) => inventory.unreadable.length > 0)
      .map((inventory) => inventory.providerId),
  );
  const observedProviders =
    selected === undefined ? providers : providers.filter((provider) => protectedProviders.has(provider.id));
  if (selected === undefined || observedProviders.length > 0) {
    // Only a provider that recorded state for this root fails teardown with its status failure;
    // another installed provider that cannot be observed simply contributes no evidence.
    const observations = yield* Effect.forEach(observedProviders, (provider) =>
      runtimeEvidence(
        provider,
        // Without a plan, runtime labels can be the only link between a protected slot and this root.
        teardown || protectedProviders.has(provider.id) ? { includeUnplanned: true } : {},
        teardown && selected === undefined && ownershipHints.some((hint) => hint.providerId === provider.id),
      ).pipe(Effect.result),
    );
    const evidence = observations.map((result) =>
      Result.isSuccess(result) ? result.success : { runtimeObserved: false, services: [], volumes: [] },
    );
    const candidates = groupOrphans(lookupRoot, observedProviders, evidence).filter((group) =>
      belongsToApp(group.providerId, group.appId),
    );
    for (const group of candidates) {
      yield* readProtected(group.providerId, group.appId);
    }
    yield* requireOwnershipRuntime;
    if (selected !== undefined) return { kind: "applied", plan: selected, ...owned };
    for (const result of observations)
      if (Result.isFailure(result)) return yield* Effect.fail(result.failure);
    yield* refuseContradictoryOrphans({
      root: lookupRoot,
      providers: observedProviders,
      evidence,
      isProtected,
    });
    const groups = candidates.filter((group) => !isProtected(group.providerId, group.appId));
    return groups.length > 0
      ? { kind: "orphans" as const, groups, ...owned }
      : ownershipHints.length > 0
        ? { kind: "owned", ownership: ownershipHints }
        : { kind: "absent" as const };
  }
  yield* requireOwnershipRuntime;
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
  collectEvidence(root, providers, "exact", app, true);

/**
 * Fail-closed applied-state resolution for every non-teardown caller: orphaned runtime resources
 * are a refusal, never a teardown target. `"ancestor"` answers a working directory inside an app;
 * `"exact"` answers only for the app root the caller already resolved.
 */
export const resolveAppliedPlanEvidence = (
  root: AbsolutePath,
  providers: ReadonlyArray<AppliedStateProvider>,
  app?: Pick<AppRef, "kind" | "id">,
  lookup: AppliedPlanLookup = "ancestor",
): Effect.Effect<AppPlan | undefined, AppResolveError | ProviderError> =>
  collectEvidence(root, providers, lookup, app).pipe(
    Effect.flatMap((evidence) => {
      switch (evidence.kind) {
        case "applied":
          return Effect.succeed(evidence.plan);
        case "orphans":
        case "owned":
          return Effect.fail(orphanRefusal);
        case "absent":
          return Effect.succeed(undefined);
        default: {
          const exhaustive: never = evidence;
          return exhaustive;
        }
      }
    }),
  );

/** Empty inventory for pure doubles that do not exercise protection. */
export const emptyAppliedStateInventory = emptyInventory;
