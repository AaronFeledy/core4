import { Effect } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import type { EndpointPlan, ServiceConfig, ServicePlan } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition } from "@lando/sdk/services";

import { type BaseSeed, type DraftServicePlan, makeDraft } from "./draft.ts";
import { endpointValidationError, normalizeEndpoints } from "./endpoint-normalizer.ts";
import {
  type ApplicationConfig,
  type PreparedServiceComposition,
  applicationFeatureConfig,
  declarePreparedServiceEndpoints,
  prepareServiceComposition,
} from "./feature-preparation.ts";
import { finalizeDraft } from "./finalize-service.ts";

export type { BaseSeed } from "./draft.ts";

export interface ComposeServiceFeature {
  readonly id: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly definition: ServiceFeatureDefinition;
}

export interface ComposeServiceInput {
  readonly base: BaseSeed;
  readonly baseKind: ServiceFeatureContext["base"];
  readonly appName?: string | undefined;
  readonly appRoot: ServiceFeatureContext["appRoot"];
  readonly host?: ServiceFeatureContext["host"];
  readonly normalizedConfig: ServiceConfig;
  readonly features: ReadonlyArray<ComposeServiceFeature>;
}

const makeContext = (
  input: PreparedServiceComposition["facts"],
  draft: DraftServicePlan,
  config: Readonly<Record<string, unknown>>,
): ServiceFeatureContext => ({
  serviceName: draft.name,
  serviceType: draft.type,
  base: input.baseKind,
  primary: draft.primary,
  appName: input.appName,
  appRoot: input.appRoot,
  host: input.host,
  normalizedConfig: input.normalizedConfig,
  connection: draft.connection,
  config,
  addEnv: (name, value) => {
    draft.environment[name] = value;
  },
  addMount: (mount) => {
    draft.mounts.push({ ...mount });
  },
  setAppMount: (mount) => {
    draft.appMount = { ...mount };
  },
  addBuildStep: (step) => {
    draft.buildSteps.push({ ...step });
  },
  addExtension: (key, value) => {
    if (draft.extensions === undefined) draft.extensions = {};
    draft.extensions[key] = value;
  },
  addStorage: (storage, ownership) => {
    draft.storage.push({ ...storage });
    if (ownership !== undefined) {
      const owned = draft.storageOwnership ?? [];
      owned.push({ target: String(storage.target), seededOwners: [...ownership.seededOwners] });
      draft.storageOwnership = owned;
    }
  },
  addDependency: (dependency) => {
    draft.dependsOn.push({ ...dependency });
  },
  addHostAlias: (alias) => {
    draft.hostAliases.push({ ...alias });
  },
  setHealthcheck: (healthcheck) => {
    draft.healthcheck = { ...healthcheck };
  },
  setReadiness: (readiness) => {
    draft.readiness = { ...readiness };
  },
  setCerts: (certs) => {
    draft.certs = { ...certs };
  },
  setEntrypoint: (entrypoint) => {
    draft.entrypoint = Array.isArray(entrypoint) ? [...entrypoint] : entrypoint;
  },
  setCommand: (command) => {
    draft.command = Array.isArray(command) ? [...command] : command;
  },
  setArtifact: (artifact) => {
    draft.artifact = { ...artifact };
  },
  setUser: (user) => {
    draft.user = user;
  },
  setWorkingDirectory: (path) => {
    draft.workingDirectory = path;
  },
});

export const applyPreparedService = Effect.fn("ServiceFeature.applyPreparedService")(function* (input: {
  readonly prepared: PreparedServiceComposition;
  readonly endpointContributions: readonly EndpointPlan[];
  readonly applicationConfigs: ReadonlyMap<number, ApplicationConfig>;
}): Effect.fn.Return<
  {
    readonly plan: ServicePlan;
    readonly endpointContributions: readonly EndpointPlan[];
    readonly featureIds: readonly string[];
  },
  ServiceFeatureError
> {
  const facts = input.prepared.facts;
  const draft = makeDraft({ ...facts.base, defaultFeatures: [] });
  const orderedFeatures = input.prepared.features;
  draft.featureIds = orderedFeatures.map((feature) => feature.id);
  const endpointContributions = input.endpointContributions;
  draft.endpoints = endpointContributions.map((endpoint) => ({ ...endpoint }));

  yield* Effect.forEach(
    orderedFeatures,
    (feature) =>
      Effect.gen(function* () {
        const config = yield* applicationFeatureConfig(
          feature,
          input.applicationConfigs.get(feature.index) ?? { _tag: "Original" },
        );
        yield* feature.definition.apply(makeContext(facts, draft, config));
      }),
    { discard: true },
  );

  const finalized = finalizeDraft(draft);
  if (finalized instanceof ServiceFeatureError) return yield* Effect.fail(finalized);
  return { plan: finalized, endpointContributions, featureIds: draft.featureIds };
});

export const composeServiceWithContributions = Effect.fn("ServiceFeature.composeServiceWithContributions")(
  function* (input: ComposeServiceInput) {
    const declared = yield* declarePreparedServiceEndpoints(prepareServiceComposition(input));
    return yield* applyPreparedService({
      prepared: declared.prepared,
      endpointContributions: declared.contributions,
      applicationConfigs: new Map(),
    });
  },
);

export const composeService = Effect.fn("ServiceFeature.composeService")(function* (
  input: ComposeServiceInput,
): Effect.fn.Return<ServicePlan, ServiceFeatureError> {
  const { plan, endpointContributions } = yield* composeServiceWithContributions(input);
  const endpoints = normalizeEndpoints(endpointContributions, input.normalizedConfig);
  const endpointError = endpointValidationError(endpoints, {
    appRoot: input.appRoot,
    serviceName: plan.name,
  });
  if (endpointError !== undefined) {
    return yield* Effect.fail(
      new ServiceFeatureError({
        message: endpointError.message,
        feature: "endpoints",
        cause: endpointError,
      }),
    );
  }
  return { ...plan, endpoints };
});
