import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  type AppId,
  type AppPlan,
  type BringDownOptions,
  type BringDownOutcome,
  type ContainerDisposition,
  type ObservedBringDown,
  planAppIdentity,
} from "@lando/sdk/schema";
import {
  AppPlanSanitizer,
  type ApplyOptions,
  ContainerHelperAssets,
  EventService,
  PathsService,
  type ProviderError,
  type RuntimeProviderShape,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { type AppliedPlanCacheOptions, makeAppliedPlanCache } from "./applied-plan-cache.ts";
import { adoptLegacyDataRoot } from "./data-root-adoption.ts";
import { refuseOtherAppsResources } from "./foreign-owner.ts";
import { volumeCoordinationKey } from "./native-volume-identity.ts";
import { removeOrphanedNetworks } from "./orphaned-networks.ts";
import { makeOwnedResourcesCleanup } from "./resource-cleanup.ts";
import { makeResourceOwnershipStore } from "./resource-ownership.ts";
import { bringDownObservedContainer } from "./service-lifecycle.ts";

export { makeOwnedResourcesCleanup } from "./resource-cleanup.ts";
export { makeResourceOwnershipStore } from "./resource-ownership.ts";
export { hasResourceOwnershipRecords } from "./resource-ownership-records.ts";
export { PlanfulVolumeCoverage } from "./teardown-volumes.ts";
export const hasExactVolumeTeardown = (provider: object): boolean =>
  "exactVolumeTeardown" in provider && provider.exactVolumeTeardown === true;

import { type ProviderDataPlaneOptions, makeProviderDataPlane } from "./data-plane.ts";
import type { LifecycleDialect } from "./dialect.ts";
import type { EngineHttpApi, ProviderErrorContext } from "./engine-api.ts";
import { bringDown, stopAppContainers } from "./podman/bring-down.ts";
import { type EmitComposeOptions, composePath, emitCompose, renderCompose } from "./podman/compose.ts";
import { type ResolvedProviderOpsInput, makeResolvedProviderOps } from "./runtime-provider.ts";

/**
 * Host inputs for provider factories. Container helper resolution is lazy via
 * `resolveContainerHelper` — no helper bytes are read at construction.
 */
export const providerHostInputs = Effect.gen(function* () {
  const paths = yield* PathsService;
  const assets = yield* ContainerHelperAssets;
  const appPlanSanitizer = yield* AppPlanSanitizer;
  const eventService = yield* Effect.serviceOption(EventService);
  return {
    paths,
    platform: paths.platform,
    resolveContainerHelper: assets.resolve,
    sanitizeAppliedPlan: appPlanSanitizer.sanitizeForPersistence,
    ...Option.match(eventService, { onNone: () => ({}), onSome: (eventService) => ({ eventService }) }),
  };
});

type ProviderPlanStateOptions = AppliedPlanCacheOptions &
  Omit<ProviderDataPlaneOptions, "api" | "providerId" | "redactorFor"> & {
    readonly ctx: ProviderErrorContext;
    readonly userDataRoot?: string | undefined;
    readonly api?: ProviderDataPlaneOptions["api"];
  };

const makeOwnership = (options: ProviderPlanStateOptions) => {
  const store = makeResourceOwnershipStore(options.ctx.providerId, options.appliedPlanState);
  const receiptsAt = (root: AppPlan["root"]) =>
    store
      .load(root)
      .pipe(Effect.map((inventory) => inventory?.adoptions?.flatMap((batch) => batch.receipts) ?? []));
  const receiptsFor = Effect.fnUntraced(function* (plan: AppPlan) {
    if (plan.identity?.dataRoot === undefined) return [];
    return yield* receiptsAt(planAppIdentity(plan).appRoot);
  });
  const adopt = Effect.fn("ProviderOwnership.adopt")(function* (
    plan: AppPlan,
    previous: AppPlan | undefined,
    witness: Parameters<NonNullable<RuntimeProviderShape["adoptDataRoot"]>>[1],
  ) {
    const api = options.api;
    if (api?.request === undefined) return;
    yield* adoptLegacyDataRoot(plan, previous, {
      request: api.request,
      store,
      volumeWitness: (name) =>
        volumeCoordinationKey({ ...options, api, providerId: options.ctx.providerId }, name).pipe(
          Effect.flatMap((key) => (key === undefined ? Effect.succeed(undefined) : witness(key))),
        ),
    });
  });
  return {
    ...store,
    adopt,
    receiptsFor,
    receiptsAt,
    prepare: Effect.fn("ProviderOwnership.prepare")(function* (plan: AppPlan, previous?: AppPlan) {
      yield* refuseOtherAppsResources(plan, previous, {
        ctx: options.ctx,
        ...(options.api === undefined ? {} : { api: options.api }),
      });
      const owner = planAppIdentity(plan);
      if (
        owner.dataRoot !== undefined &&
        previous !== undefined &&
        previous.root === plan.root &&
        previous.identity?.dataRoot === undefined
      ) {
        const inventory = yield* store.load(owner.appRoot);
        if (
          !inventory?.adoptions?.some(
            (batch) => batch.dataRoot === owner.dataRoot && batch.previousAppId === previous.id,
          )
        ) {
          return yield* new ProviderUnavailableError({
            providerId: options.ctx.providerId,
            operation: "data-root-adoption",
            message: "The legacy applied plan has not been checked for data-root adoption.",
            remediation:
              "Start the app through Lando so it can verify legacy resources and volume initialization before applying the new plan.",
          });
        }
      }
      yield* store.prepare(plan, previous);
      return yield* receiptsFor(plan);
    }),
  };
};

interface ProviderBringDownRuntime {
  readonly api?: EngineHttpApi;
  readonly dialect?: LifecycleDialect;
}

/**
 * Shared bring-down for one provider engine client. `app` runs one disposition over a resolved plan:
 * `stop` keeps every owned container, `remove` deletes them with networks and requested volumes,
 * then forgets the applied plan unless it is kept. `observed` proves the live container's ownership
 * against the provider's data root (or the recorded plan's) and the adoption receipts at the
 * observed root before acting.
 */
const makeProviderBringDown =
  (
    options: ProviderPlanStateOptions,
    ownership: ReturnType<typeof makeOwnership>,
    appliedPlans: ReturnType<typeof makeAppliedPlanCache>,
  ) =>
  (runtime: ProviderBringDownRuntime) => ({
    app: Effect.fn("RuntimeProvider.bringDownApp")(function* (
      request: { readonly app: AppId; readonly plan: AppPlan; readonly options: BringDownOptions },
      /** Runs after the containers were brought down, before applied state is forgotten. */
      afterContainers: Effect.Effect<unknown> = Effect.void,
    ): Effect.fn.Return<BringDownOutcome, ProviderError> {
      const { plan, options: bringDownOptions } = request;
      const containerRuntime = {
        adoptionReceipts: yield* ownership.receiptsFor(plan),
        ctx: options.ctx,
        ...(runtime.api === undefined ? {} : { api: runtime.api }),
        ...(runtime.dialect === undefined ? {} : { dialect: runtime.dialect }),
      };
      if (bringDownOptions.containers === "stop") {
        const stopped = yield* stopAppContainers(plan, containerRuntime);
        yield* afterContainers;
        return {
          kind: "stopped",
          containers: stopped.receipts,
          shutdownObservations: stopped.shutdownObservations,
        };
      }
      const removed = yield* bringDown(plan, {
        ...containerRuntime,
        ...(options.endpointNamespace === undefined ? {} : { endpointNamespace: options.endpointNamespace }),
        volumes: bringDownOptions.volumes,
        ...(bringDownOptions.purgeCaches === undefined ? {} : { purgeCaches: bringDownOptions.purgeCaches }),
      });
      yield* afterContainers;
      yield* forgetAppliedPlanUnlessKept(appliedPlans, request.app, bringDownOptions);
      return {
        kind: "removed",
        containers: removed.receipts,
        volumesRemoved: removed.volumesRemoved,
        shutdownObservations: removed.shutdownObservations,
        ...(removed.skipped === undefined ? {} : { skipped: removed.skipped }),
      };
    }),
    observed: Effect.fn("RuntimeProvider.bringDownObserved")(function* (
      observed: ServiceRuntimeInfo,
      containers: ContainerDisposition,
    ): Effect.fn.Return<ObservedBringDown, ProviderError> {
      const plan = yield* appliedPlans.resolveMutationPlan(observed.app);
      // The live inspect by id supplies the native name the receipts are matched against, so a
      // listed row without one still gets them.
      const receipts = observed.appRoot === undefined ? [] : yield* ownership.receiptsAt(observed.appRoot);
      return yield* bringDownObservedContainer(observed, containers, {
        ctx: options.ctx,
        ...(runtime.api === undefined ? {} : { api: runtime.api }),
        dataRoot: options.userDataRoot ?? plan?.identity?.dataRoot,
        receipts,
      });
    }),
  });

export const makeProviderPlanState = (options: ProviderPlanStateOptions) => {
  const ownership = makeOwnership(options);
  const appliedPlans = makeAppliedPlanCache(options);
  return {
    ownership,
    appliedPlans,
    bringDownWith: makeProviderBringDown(options, ownership, appliedPlans),
    ...makeProviderResources(options),
  };
};

const makeProviderResources = (options: ProviderPlanStateOptions) => ({
  removeOrphanedNetworks: (plan: AppPlan, previous: AppPlan | undefined) =>
    removeOrphanedNetworks(plan, previous, {
      ctx: options.ctx,
      ...(options.api === undefined ? {} : { api: options.api }),
      store: makeResourceOwnershipStore(options.ctx.providerId, options.appliedPlanState),
    }),
  cleanupOwnedResources: makeOwnedResourcesCleanup({
    userDataRoot: options.userDataRoot,
    checkAppliedState: (app) =>
      options.appliedPlanState === undefined
        ? Effect.void
        : options.load(options.appliedPlanState, app).pipe(Effect.asVoid),
    store: makeResourceOwnershipStore(options.ctx.providerId, options.appliedPlanState),
    ctx: options.ctx,
    ...(options.endpointNamespace === undefined ? {} : { endpointNamespace: options.endpointNamespace }),
    ...(options.api === undefined ? {} : { api: options.api }),
  }),
  ...(options.api === undefined
    ? {}
    : {
        dataPlane: makeProviderDataPlane({
          providerId: options.ctx.providerId,
          api: options.api,
          capabilities: options.capabilities,
          redactor: options.redactor,
          ...(options.ctx.redactorFor === undefined ? {} : { redactorFor: options.ctx.redactorFor }),
          ...(options.pullHelperImage === undefined ? {} : { pullHelperImage: options.pullHelperImage }),
          ...(options.volumeCreationLabels === undefined
            ? {}
            : { volumeCreationLabels: options.volumeCreationLabels }),
          ...(options.endpointNamespace === undefined
            ? {}
            : { endpointNamespace: options.endpointNamespace }),
        }),
      }),
});

export const bindResolvedProviderOps = (
  state: ReturnType<typeof makeProviderPlanState>,
  input: Omit<ResolvedProviderOpsInput, "resolvePlan" | "dataPlane">,
) => ({
  exactVolumeTeardown: true,
  ...makeResolvedProviderOps({
    ...input,
    beforeMutation:
      input.beforeMutation ?? ((app) => state.appliedPlans.resolveMutationPlan(app).pipe(Effect.asVoid)),
    resolvePlan: state.appliedPlans.resolvePlan,
    ...(state.dataPlane === undefined ? {} : { dataPlane: state.dataPlane }),
  }),
});

export const rememberAppliedPlan = (
  appliedPlans: Pick<ReturnType<typeof makeAppliedPlanCache>, "rememberPlan">,
  plan: AppPlan,
  applyOptions: Pick<ApplyOptions, "recordedPlan" | "complete">,
) =>
  appliedPlans.rememberPlan(applyOptions.recordedPlan ?? plan, {
    complete: applyOptions.complete === true,
  });

/** A `remove` bring-down forgets the applied plan unless `removeState: false` keeps it; `stop` never does. */
export const forgetAppliedPlanUnlessKept = (
  appliedPlans: Pick<ReturnType<typeof makeAppliedPlanCache>, "forgetPlan">,
  app: AppId,
  options: BringDownOptions,
) =>
  options.containers === "stop" || options.removeState === false ? Effect.void : appliedPlans.forgetPlan(app);

export const noPlanErrorFactory =
  (options: { readonly providerId: string; readonly implementer: string; readonly remediation: string }) =>
  (appId: AppId, operation: string) =>
    new ProviderUnavailableError({
      providerId: options.providerId,
      operation,
      message: `No applied plan found for app "${appId}". ${options.implementer} does implement ${operation}, but the app must be started first.`,
      remediation: options.remediation,
    });

export const notImplementedError = (providerId: string, operation: string) =>
  new ProviderUnavailableError({
    providerId,
    operation,
    message: `provider-${providerId} does not implement ${operation}.`,
    remediation: "Install or start the selected runtime provider, then re-run the failed command.",
  });

export const composeAdaptersFor = (ctx: ProviderErrorContext) => ({
  renderCompose: (plan: AppPlan) => renderCompose(plan, ctx),
  emitCompose: (plan: AppPlan, options: Omit<EmitComposeOptions, "ctx">) =>
    emitCompose(plan, { ...options, ctx }),
  composePath: (plan: AppPlan, options: Omit<EmitComposeOptions, "ctx">) =>
    composePath(plan, { ...options, ctx }),
});
