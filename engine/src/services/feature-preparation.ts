import { ServiceFeatureError } from "@lando/sdk/errors";
import type { EndpointPlan } from "@lando/sdk/schema";
import type { AppFeatureServiceView, ServiceFeatureDefinition } from "@lando/sdk/services";
import { Effect, Result, Schema, SchemaIssue } from "effect";
import { sortRecord } from "./draft.ts";
import type { ComposeServiceInput } from "./feature.ts";

export interface PreparedServiceFeature {
  readonly id: string;
  readonly index: number;
  readonly definition: ServiceFeatureDefinition;
  readonly originalRawConfig: Readonly<Record<string, unknown>>;
  readonly originalDecodedConfig?: Readonly<Record<string, unknown>>;
}

export type ApplicationConfig =
  | { readonly _tag: "Original" }
  | { readonly _tag: "Materialized"; readonly config: Readonly<Record<string, unknown>> };

export interface PreparedServiceComposition {
  readonly facts: Omit<ComposeServiceInput, "features" | "base"> & {
    readonly base: Omit<ComposeServiceInput["base"], "defaultFeatures">;
  };
  readonly features: readonly PreparedServiceFeature[];
  readonly view: AppFeatureServiceView;
}

export const decodeServiceFeatureConfig = (
  feature: PreparedServiceFeature,
  rawConfig = feature.originalRawConfig,
): Effect.Effect<Readonly<Record<string, unknown>>, ServiceFeatureError> => {
  if (feature.definition.schema === undefined) return Effect.succeed(sortRecord(rawConfig));
  const decoded = Schema.decodeUnknownResult(feature.definition.schema)(rawConfig, {
    onExcessProperty: "error",
  });
  if (Result.isFailure(decoded)) {
    const details = SchemaIssue.makeFormatterStandardSchemaV1()(decoded.failure.issue)
      .issues.map((issue) => issue.message)
      .join("; ");
    return Effect.fail(
      new ServiceFeatureError({
        message: `Invalid service feature config: ${details}`,
        feature: feature.id,
        cause: decoded.failure,
      }),
    );
  }
  const value = decoded.success;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return Effect.fail(
      new ServiceFeatureError({
        message: "Service feature config must decode to an object",
        feature: feature.id,
      }),
    );
  return Effect.succeed(sortRecord(Object.fromEntries(Object.entries(value))));
};

export const prepareServiceComposition = (input: ComposeServiceInput): PreparedServiceComposition => {
  const { features, base, ...facts } = input;
  const { defaultFeatures, ...baseFacts } = base;
  const ordered = [...defaultFeatures.map((definition) => ({ id: definition.id, definition })), ...features]
    .map(
      (feature, index): PreparedServiceFeature => ({
        id: feature.id,
        definition: feature.definition,
        index,
        originalRawConfig: "config" in feature ? (feature.config ?? {}) : {},
      }),
    )
    .sort((left, right) => left.definition.priority - right.definition.priority || left.index - right.index);
  return {
    facts: { ...facts, base: baseFacts },
    features: ordered,
    view: Object.freeze({
      serviceName: String(base.name),
      serviceType: base.type,
      base: input.baseKind,
      primary: base.primary,
      featureIds: Object.freeze(ordered.map((feature) => feature.id)),
      normalizedConfig: input.normalizedConfig,
      connection: base.connection,
      framework: input.normalizedConfig.framework,
    }),
  };
};

export const declarePreparedServiceEndpoints = Effect.fnUntraced(function* (
  prepared: PreparedServiceComposition,
) {
  const endpoints: EndpointPlan[] = [];
  const features: PreparedServiceFeature[] = [];
  for (const feature of prepared.features) {
    const declare = feature.definition.declareEndpoints;
    if (declare === undefined) {
      features.push(feature);
      continue;
    }
    const config = yield* decodeServiceFeatureConfig(feature);
    endpoints.push(
      ...(yield* declare({
        serviceName: prepared.facts.base.name,
        serviceType: prepared.facts.base.type,
        base: prepared.facts.baseKind,
        primary: prepared.facts.base.primary,
        appName: prepared.facts.appName,
        appRoot: prepared.facts.appRoot,
        host: prepared.facts.host,
        normalizedConfig: prepared.facts.normalizedConfig,
        connection: prepared.facts.base.connection,
        config,
      })),
    );
    features.push({ ...feature, originalDecodedConfig: config });
  }
  return { prepared: { ...prepared, features }, contributions: endpoints };
});

export const applicationFeatureConfig = (feature: PreparedServiceFeature, application: ApplicationConfig) => {
  switch (application._tag) {
    case "Original":
      return feature.originalDecodedConfig === undefined
        ? decodeServiceFeatureConfig(feature)
        : Effect.succeed(feature.originalDecodedConfig);
    case "Materialized":
      return decodeServiceFeatureConfig(feature, application.config);
    default:
      return application satisfies never;
  }
};
