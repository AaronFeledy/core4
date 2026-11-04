import { type AppFeatureError, AppFeatureSelectorMatchedNothingError } from "@lando/sdk/errors";
import type { EndpointPlan } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import {
  decodeAppFeatureConfig,
  orderAppFeatures,
  resolveAppFeatureActivation,
  snapshotAppFeatureEnv,
} from "./app-feature-selection.ts";
import type { ActivationPlan, AppFeatureSelectionInput, OrderedAppFeature } from "./app-feature-types.ts";

export interface PreparedAppFeature extends ActivationPlan {
  readonly originalDecodedConfig?: Readonly<Record<string, unknown>>;
}

export interface PreparedAppComposition {
  readonly features: readonly OrderedAppFeature[];
  readonly activations: readonly PreparedAppFeature[];
  readonly environment: ReturnType<typeof snapshotAppFeatureEnv>;
}

export const prepareAppFeatures = Effect.fnUntraced(function* (input: AppFeatureSelectionInput) {
  const features = orderAppFeatures(input.features);
  const environment = snapshotAppFeatureEnv(features, input.env);
  const activations: PreparedAppFeature[] = [];
  const errors: { readonly feature: OrderedAppFeature; readonly error: AppFeatureError }[] = [];
  for (const feature of features) {
    const result = yield* resolveAppFeatureActivation(feature, { ...input, env: environment.env }).pipe(
      Effect.result,
    );
    if (Result.isFailure(result)) errors.push({ feature, error: result.failure });
    else if (result.success !== undefined) activations.push(result.success);
  }
  return { prepared: { features, activations, environment } satisfies PreparedAppComposition, errors };
});

export const declarePreparedAppFeature = Effect.fnUntraced(function* (
  activation: PreparedAppFeature,
  input: AppFeatureSelectionInput,
) {
  const feature = activation.feature;
  const declare = feature.definition.declareEndpoints;
  if (declare === undefined) {
    const contributions: Readonly<Record<string, readonly EndpointPlan[]>> = {};
    return { activation, contributions };
  }
  const config = yield* decodeAppFeatureConfig(feature);
  const contributions = yield* declare({
    featureId: feature.id,
    appName: input.appName,
    appRoot: input.appRoot,
    config,
    selected: input.services.filter((view) => activation.selectedServices.includes(view.serviceName)),
  });
  const unselected = Object.keys(contributions).filter((name) => !activation.selectedServices.includes(name));
  if (unselected.length > 0)
    return yield* Effect.fail(
      new AppFeatureSelectorMatchedNothingError({
        feature: feature.id,
        message: `App feature ${feature.id} declared endpoints for unselected services: ${unselected.join(", ")}.`,
        remediation: "Return endpoint declarations only for selected services.",
      }),
    );
  return { activation: { ...activation, originalDecodedConfig: config }, contributions };
});
