import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type AppId, type AppPlan, planAppIdentity } from "@lando/sdk/schema";
import {
  AppPlanSanitizer,
  type ApplyOptions,
  ContainerHelperAssets,
  type DestroyOptions,
  EventService,
  PathsService,
} from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { type AppliedPlanCacheOptions, makeAppliedPlanCache } from "./applied-plan-cache.ts";
import { adoptLegacyDataRoot } from "./data-root-adoption.ts";
import { refuseOtherAppsResources } from "./foreign-owner.ts";
import { volumeCoordinationKey } from "./native-volume-identity.ts";
import { removeOrphanedNetworks } from "./orphaned-networks.ts";
import { makeOwnedResourcesCleanup } from "./resource-cleanup.ts";
import { makeResourceOwnershipStore } from "./resource-ownership.ts";

export { makeOwnedResourcesCleanup } from "./resource-cleanup.ts";
export { makeResourceOwnershipStore } from "./resource-ownership.ts";
export { hasResourceOwnershipRecords } from "./resource-ownership-records.ts";
export { PlanfulVolumeCoverage } from "./teardown-volumes.ts";
export const hasExactVolumeTeardown = (provider: object): boolean =>
  "exactVolumeTeardown" in provider && provider.exactVolumeTeardown === true;

import type { RuntimeProviderShape } from "@lando/sdk/services";
import { type ProviderDataPlaneOptions, makeProviderDataPlane } from "./data-plane.ts";
import type { ProviderErrorContext } from "./engine-api.ts";
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
    witness?: Parameters<NonNullable<RuntimeProviderShape["adoptDataRoot"]>>[1],
  ) {
    const api = options.api;
    if (api?.request === undefined) return;
    yield* adoptLegacyDataRoot(plan, previous, {
      request: api.request,
      store,
      ...(witness === undefined
        ? {}
        : {
            volumeWitness: (name: string) =>
              volumeCoordinationKey({ ...options, api, providerId: options.ctx.providerId }, name).pipe(
                Effect.flatMap((key) => (key === undefined ? Effect.succeed(undefined) : witness(key))),
              ),
          }),
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
      yield* adopt(plan, previous);
      yield* store.prepare(plan, previous);
      return yield* receiptsFor(plan);
    }),
  };
};

export const makeProviderPlanState = (options: ProviderPlanStateOptions) => ({
  removeOrphanedNetworks: (plan: AppPlan, previous: AppPlan | undefined) =>
    removeOrphanedNetworks(plan, previous, {
      ctx: options.ctx,
      ...(options.api === undefined ? {} : { api: options.api }),
      store: makeResourceOwnershipStore(options.ctx.providerId, options.appliedPlanState),
    }),
  ownership: makeOwnership(options),
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
  appliedPlans: makeAppliedPlanCache(options),
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

export const forgetAppliedPlanUnlessKept = (
  appliedPlans: Pick<ReturnType<typeof makeAppliedPlanCache>, "forgetPlan">,
  app: AppId,
  destroyOptions: Pick<DestroyOptions, "removeState">,
) => (destroyOptions.removeState === false ? Effect.void : appliedPlans.forgetPlan(app));

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
