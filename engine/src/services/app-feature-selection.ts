import { type AppFeatureError, AppFeatureSelectorMatchedNothingError } from "@lando/sdk/errors";
import {
  type ExpressionContext,
  evaluateTemplateEither,
  expressionScopeMembers,
  parseExpressionEither,
} from "@lando/sdk/expressions";
import { validationIssuesFromSchemaIssue } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import {
  type ActivationPlan,
  type AppFeatureSelectionInput,
  type ComposeAppFeature,
  type OrderedAppFeature,
  viewOf,
} from "./app-feature-types.ts";

export const orderAppFeatures = (features: readonly ComposeAppFeature[]) =>
  features
    .map((feature, index) => ({ ...feature, index }))
    .sort((left, right) => left.definition.priority - right.definition.priority || left.index - right.index);

const expressionEnv = (): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

export const snapshotAppFeatureEnv = (
  features: readonly ComposeAppFeature[],
  env: Readonly<Record<string, string>> = expressionEnv(),
): {
  readonly env: Readonly<Record<string, string>>;
  readonly bindings: Readonly<Record<string, string | null>>;
} => {
  const snapshot = Object.freeze({ ...env });
  const names = new Set<string>();
  for (const feature of features) {
    const expression = feature.definition.selectors?.fromConfig;
    if (expression === undefined) continue;
    const parsed = parseExpressionEither(expression, { filePath: "<app-feature-selector>" });
    if (Result.isFailure(parsed)) continue;
    const dependencies = expressionScopeMembers(parsed.success, "env");
    if (!dependencies.analyzable)
      return {
        env: snapshot,
        bindings: Object.fromEntries(
          Object.keys(snapshot)
            .sort()
            .map((name) => [name, snapshot[name] ?? null]),
        ),
      };
    for (const name of dependencies.members) names.add(name);
    for (const segment of parsed.success.segments)
      if (segment.kind === "ShellParamSegment") names.add(segment.name);
  }
  return {
    env: snapshot,
    bindings: Object.fromEntries([...names].sort().map((name) => [name, snapshot[name] ?? null])),
  };
};

const selectFromConfig = (
  expression: string,
  input: AppFeatureSelectionInput & { readonly env: Readonly<Record<string, string>> },
  feature: ComposeAppFeature,
): Effect.Effect<readonly string[], AppFeatureError> => {
  if (input.resolveFromConfig !== undefined)
    return input.resolveFromConfig(expression, {
      appName: input.appName,
      appRoot: input.appRoot,
      services: input.services.map(viewOf),
    });
  const parsed = parseExpressionEither(expression, { filePath: "<app-feature-selector>" });
  if (Result.isFailure(parsed))
    return Effect.fail(
      new AppFeatureSelectorMatchedNothingError({
        message: `fromConfig selector failed to parse: ${expression}`,
        feature: feature.id,
        remediation: "Fix the fromConfig expression so it resolves to a list of service names.",
      }),
    );
  const context: ExpressionContext = {
    app: { name: input.appName, root: input.appRoot },
    env: input.env,
    services: Object.fromEntries(
      input.services.map((service) => [service.serviceName, { config: service.normalizedConfig }]),
    ),
    vars: feature.config ?? {},
  };
  const evaluated = evaluateTemplateEither(parsed.success, context);
  if (Result.isFailure(evaluated))
    return Effect.fail(
      new AppFeatureSelectorMatchedNothingError({
        message: `fromConfig selector failed to evaluate: ${expression}`,
        feature: feature.id,
        remediation: "Ensure the referenced service config yields a list of service names.",
      }),
    );
  const value = evaluated.success;
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string"))
    return Effect.fail(
      new AppFeatureSelectorMatchedNothingError({
        message: `fromConfig selector must yield a string[] of service names: ${expression}`,
        feature: feature.id,
        remediation: "Return a list of service names from the fromConfig expression.",
      }),
    );
  return Effect.succeed(value);
};

export const selectAppFeatureServices = Effect.fnUntraced(function* (
  feature: ComposeAppFeature,
  input: AppFeatureSelectionInput & { readonly env: Readonly<Record<string, string>> },
): Effect.fn.Return<readonly string[], AppFeatureError> {
  const selectors = feature.definition.selectors;
  if (selectors === undefined) return input.services.map((service) => service.serviceName);
  const matched = new Set<string>();
  for (const service of input.services) {
    if (selectors.types?.includes(service.serviceType)) matched.add(service.serviceName);
    else if (service.framework !== undefined && selectors.framework?.includes(service.framework))
      matched.add(service.serviceName);
    else if (selectors.hasFeature?.some((id) => service.featureIds.includes(id)))
      matched.add(service.serviceName);
    else if (selectors.names?.includes(service.serviceName)) matched.add(service.serviceName);
  }
  if (selectors.fromConfig !== undefined) {
    const names = yield* selectFromConfig(selectors.fromConfig, input, feature);
    const valid = new Set(input.services.map((service) => service.serviceName));
    for (const name of names) if (valid.has(name)) matched.add(name);
  }
  return input.services.map((service) => service.serviceName).filter((name) => matched.has(name));
});

export const decodeAppFeatureConfig = (
  feature: ComposeAppFeature,
): Effect.Effect<Readonly<Record<string, unknown>>, AppFeatureError> => {
  const rawConfig = feature.config ?? {};
  if (feature.definition.schema === undefined) return Effect.succeed(rawConfig);
  const decoded = Schema.decodeUnknownResult(feature.definition.schema)(rawConfig, {
    onExcessProperty: "error",
  });
  if (Result.isSuccess(decoded)) {
    const value = decoded.success;
    return Effect.succeed(
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : rawConfig,
    );
  }
  const details = validationIssuesFromSchemaIssue(decoded.failure.issue)
    .map((issue) => issue.message)
    .join("; ");
  return Effect.fail(
    new AppFeatureSelectorMatchedNothingError({
      message: details.length > 0 ? `Invalid app feature config: ${details}` : "Invalid app feature config",
      feature: feature.definition.id,
      remediation: "Correct the app feature configuration so selectors and options are valid.",
    }),
  );
};

export const resolveAppFeatureActivation = Effect.fnUntraced(function* (
  feature: OrderedAppFeature,
  input: AppFeatureSelectionInput & { readonly env: Readonly<Record<string, string>> },
): Effect.fn.Return<ActivationPlan | undefined, AppFeatureError> {
  const match = feature.definition.activatedBy?.services;
  const triggeredByServices = input.services
    .filter(
      (service) =>
        (match?.type === undefined || service.serviceType === match.type) &&
        (match?.hasFeature === undefined || service.featureIds.includes(match.hasFeature)),
    )
    .map((service) => service.serviceName);
  if (triggeredByServices.length === 0) return undefined;
  const selectedServices = yield* selectAppFeatureServices(feature, input);
  if (selectedServices.length === 0)
    return yield* Effect.fail(
      new AppFeatureSelectorMatchedNothingError({
        message: `App feature ${feature.definition.id} activated but selected no service`,
        feature: feature.definition.id,
        remediation: "Adjust the feature selectors so they match at least one service draft.",
      }),
    );
  return { feature, triggeredByServices, selectedServices };
});
