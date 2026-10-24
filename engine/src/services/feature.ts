import { SchemaIssue } from "effect";
import { Effect, Result, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import type { EndpointPlan, ServiceConfig, ServicePlan } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition } from "@lando/sdk/services";

import { type BaseSeed, type DraftServicePlan, makeDraft, sortRecord } from "./draft.ts";
import { endpointValidationError, normalizeEndpoints } from "./endpoint-normalizer.ts";
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

interface OrderedFeature extends ComposeServiceFeature {
  readonly index: number;
}

const recordConfig = (
  input: unknown,
  feature: string,
): Effect.Effect<Readonly<Record<string, unknown>>, ServiceFeatureError> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return Effect.fail(
      new ServiceFeatureError({ message: "Service feature config must decode to an object", feature }),
    );
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) output[key] = value;
  return Effect.succeed(sortRecord(output));
};

const decodeFeatureConfig = (
  feature: OrderedFeature,
): Effect.Effect<Readonly<Record<string, unknown>>, ServiceFeatureError> => {
  const rawConfig = feature.config ?? {};
  if (feature.definition.schema === undefined) return Effect.succeed(sortRecord(rawConfig));

  const decoded = Schema.decodeUnknownResult(feature.definition.schema)(rawConfig, {
    onExcessProperty: "error",
  });
  if (Result.isSuccess(decoded)) return recordConfig(decoded.success, feature.id);

  const details = SchemaIssue.makeFormatterStandardSchemaV1()(decoded.failure.issue)
    .issues.map((issue) => issue.message)
    .join("; ");
  return Effect.fail(
    new ServiceFeatureError({
      message:
        details.length > 0 ? `Invalid service feature config: ${details}` : "Invalid service feature config",
      feature: feature.id,
      cause: decoded.failure,
    }),
  );
};

const stableFeatureOrder = (input: ComposeServiceInput): ReadonlyArray<OrderedFeature> =>
  [...input.base.defaultFeatures.map((definition) => ({ id: definition.id, definition })), ...input.features]
    .map((feature, index) => ({ ...feature, index }))
    .sort((left, right) => left.definition.priority - right.definition.priority || left.index - right.index);

const makeContext = (
  input: ComposeServiceInput,
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
  addEndpoint: (endpoint) => {
    draft.endpoints.push({ ...endpoint });
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

export const composeServiceWithContributions = Effect.fn("ServiceFeature.composeServiceWithContributions")(
  function* (
    input: ComposeServiceInput,
  ): Effect.fn.Return<
    { readonly plan: ServicePlan; readonly endpointContributions: readonly EndpointPlan[] },
    ServiceFeatureError
  > {
    const draft = makeDraft(input.base);
    const orderedFeatures = stableFeatureOrder(input);
    draft.featureIds = orderedFeatures.map((feature) => feature.id);

    yield* Effect.forEach(
      orderedFeatures,
      (feature) =>
        Effect.gen(function* () {
          const config = yield* decodeFeatureConfig(feature);
          yield* feature.definition.apply(makeContext(input, draft, config));
        }),
      { discard: true },
    );

    const endpointContributions = draft.endpoints;
    const finalized = finalizeDraft(draft);
    if (finalized instanceof ServiceFeatureError) return yield* Effect.fail(finalized);
    return { plan: finalized, endpointContributions };
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
