import { Effect } from "effect";

import {
  type PlanMetadata,
  ProviderId,
  type ServiceConfig,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { ServiceFeatureDefinition, ServiceType, ServiceTypeHostFacts } from "@lando/sdk/services";

import { L337_BASE_DEFAULT_FEATURE_IDS } from "../../../../core/src/services/base/l337.ts";
import { LANDO_BASE_DEFAULT_FEATURE_IDS } from "../../../../core/src/services/base/lando.ts";
import { type ComposeServiceFeature, composeService } from "../../../../core/src/services/feature.ts";
import {
  applyAuthoredAppMount,
  applyAuthoredHealthcheck,
  mergeDefaultExcludes,
} from "../../../../core/src/services/planner.ts";
import { serviceFeatures } from "../../src/features/index.ts";

export interface ComposeServicePlanArgs {
  readonly serviceType: ServiceType;
  readonly service: ServiceConfig;
  readonly appRoot: string;
  readonly appName?: string;
  readonly provider?: ProviderId;
  readonly primary?: boolean;
  readonly serviceName?: string;
  readonly metadata: typeof PlanMetadata.Encoded;
  readonly host?: ServiceTypeHostFacts;
  readonly applyAuthoredWrappers?: boolean;
  readonly featureOverrides?: ReadonlyMap<string, ServiceFeatureDefinition>;
}

const baseDefaultFeatureIds = (base: "l337" | "lando"): ReadonlyArray<string> =>
  base === "lando" ? LANDO_BASE_DEFAULT_FEATURE_IDS : L337_BASE_DEFAULT_FEATURE_IDS;

const featureDefinitionFor = (
  id: string,
  featureOverrides: ReadonlyMap<string, ServiceFeatureDefinition> | undefined,
): ServiceFeatureDefinition => {
  const definition = featureOverrides?.get(id) ?? serviceFeatures.get(id);
  if (definition === undefined)
    throw new Error(`Service feature "${id}" is not registered in the test harness.`);
  return definition;
};

const composeFeatureFor = (
  featureRef: { readonly id: string; readonly config?: Record<string, unknown> },
  featureOverrides: ReadonlyMap<string, ServiceFeatureDefinition> | undefined,
): ComposeServiceFeature => ({
  id: featureRef.id,
  ...(featureRef.config === undefined ? {} : { config: featureRef.config }),
  definition: featureDefinitionFor(featureRef.id, featureOverrides),
});

export const composeServicePlan = async (args: ComposeServicePlanArgs): Promise<ServicePlan> => {
  const serviceName = args.serviceName ?? "web";
  const provider = args.provider ?? ProviderId.make("lando");
  const resolution = await Effect.runPromise(
    args.serviceType.resolve({
      name: serviceName,
      service: args.service,
      appRoot: args.appRoot,
      appName: args.appName,
      provider: args.provider,
      primary: args.primary,
      metadata: args.metadata,
      host: args.host,
    }),
  );

  const resolutionFeatureIds = new Set(resolution.features.map((feature) => feature.id));
  const baseDefaultIds = baseDefaultFeatureIds(resolution.base).filter((id) => !resolutionFeatureIds.has(id));
  const defaultFeatures = baseDefaultIds.map((id) => featureDefinitionFor(id, args.featureOverrides));
  const features = resolution.features.map((featureRef) =>
    composeFeatureFor(featureRef, args.featureOverrides),
  );
  const rawPlan = await Effect.runPromise(
    composeService({
      base: {
        name: ServiceName.make(serviceName),
        type: resolution.normalizedConfig.type ?? args.serviceType.id,
        provider,
        primary: resolution.normalizedConfig.primary ?? serviceName === "web",
        ...(resolution.normalizedConfig.environment === undefined
          ? {}
          : { environment: resolution.normalizedConfig.environment }),
        defaultFeatures,
      },
      baseKind: resolution.base,
      appName: args.appName,
      appRoot: args.appRoot,
      normalizedConfig: resolution.normalizedConfig,
      features,
      host: args.host,
    }),
  );

  if (args.applyAuthoredWrappers === false) return rawPlan;
  return applyAuthoredHealthcheck(
    applyAuthoredAppMount(mergeDefaultExcludes(rawPlan), args.service),
    args.service,
  );
};
