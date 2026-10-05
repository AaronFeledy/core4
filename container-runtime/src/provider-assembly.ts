import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { AppId, AppPlan } from "@lando/sdk/schema";
import {
  AppPlanSanitizer,
  type ApplyOptions,
  type DestroyOptions,
  EventService,
  LogFileHelperAssets,
  PathsService,
} from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { type AppliedPlanCacheOptions, makeAppliedPlanCache } from "./applied-plan-cache.ts";
import { type ProviderDataPlaneOptions, makeProviderDataPlane } from "./data-plane.ts";
import type { ProviderErrorContext } from "./engine-api.ts";
import { type EmitComposeOptions, composePath, emitCompose, renderCompose } from "./podman/compose.ts";
import { type ResolvedProviderOpsInput, makeResolvedProviderOps } from "./runtime-provider.ts";

export const providerHostInputs = Effect.gen(function* () {
  const paths = yield* PathsService;
  const assets = yield* LogFileHelperAssets;
  const appPlanSanitizer = yield* AppPlanSanitizer;
  const eventService = yield* Effect.serviceOption(EventService);
  const logFileHelperPayloads = yield* assets.payloads;
  return {
    paths,
    platform: paths.platform,
    logFileHelperPayloads,
    sanitizeAppliedPlan: appPlanSanitizer.sanitizeForPersistence,
    ...Option.match(eventService, { onNone: () => ({}), onSome: (eventService) => ({ eventService }) }),
  };
});

type ProviderPlanStateOptions = AppliedPlanCacheOptions &
  Omit<ProviderDataPlaneOptions, "api" | "providerId"> & {
    readonly ctx: ProviderErrorContext;
    readonly api?: ProviderDataPlaneOptions["api"];
  };

export const makeProviderPlanState = (options: ProviderPlanStateOptions) => ({
  ...(options.api === undefined
    ? {}
    : {
        dataPlane: makeProviderDataPlane({
          providerId: options.ctx.providerId,
          api: options.api,
          snapshotMode: options.snapshotMode,
          redactDetails: options.redactDetails,
          ...(options.prepareWitnessImage === undefined
            ? {}
            : { prepareWitnessImage: options.prepareWitnessImage }),
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
) =>
  makeResolvedProviderOps({
    ...input,
    resolvePlan: state.appliedPlans.resolvePlan,
    ...(state.dataPlane === undefined ? {} : { dataPlane: state.dataPlane }),
  });

export const rememberAppliedPlan = (
  appliedPlans: Pick<ReturnType<typeof makeAppliedPlanCache>, "rememberPlan">,
  plan: AppPlan,
  applyOptions: Pick<ApplyOptions, "recordedPlan" | "reconcile">,
) => appliedPlans.rememberPlan(applyOptions.recordedPlan ?? plan, applyOptions.reconcile);

export const forgetAppliedPlanUnlessKept = (
  appliedPlans: Pick<ReturnType<typeof makeAppliedPlanCache>, "forgetPlan">,
  app: AppId,
  destroyOptions: Pick<DestroyOptions, "removeState">,
) => (destroyOptions.removeState === false ? Effect.void : appliedPlans.forgetPlan(app));

export const noPlanErrorFactory =
  (options: {
    readonly providerId: string;
    readonly implementer: string;
    readonly remediation: string;
  }) =>
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
    message: `provider-${providerId} does not implement ${operation} yet.`,
  });

export const composeAdaptersFor = (ctx: ProviderErrorContext) => ({
  renderCompose: (plan: AppPlan) => renderCompose(plan, ctx),
  emitCompose: (plan: AppPlan, options: Omit<EmitComposeOptions, "ctx">) =>
    emitCompose(plan, { ...options, ctx }),
  composePath: (plan: AppPlan, options: Omit<EmitComposeOptions, "ctx">) =>
    composePath(plan, { ...options, ctx }),
});
