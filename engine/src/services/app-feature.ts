import {
  AppFeatureCycleError,
  type AppFeatureError,
  AppFeatureMutationConflictError,
} from "@lando/sdk/errors";
import type { ProviderCapabilities } from "@lando/sdk/schema";
import type { AppFeatureDefinition } from "@lando/sdk/services";
import { Cause, Effect, Graph, Option, Result } from "effect";
import { makeAppFeatureContext } from "./app-feature-mutations.ts";
import {
  type PreparedAppComposition,
  declarePreparedAppFeature,
  prepareAppFeatures,
} from "./app-feature-preparation.ts";
import { decodeAppFeatureConfig } from "./app-feature-selection.ts";
import type {
  ActivatedAppFeature,
  ActivationPlan,
  AppFeatureApplicationInput,
  ComposeAppFeaturesInput,
  ComposeAppFeaturesResult,
} from "./app-feature-types.ts";

export type * from "./app-feature-types.ts";
export { viewOf } from "./app-feature-types.ts";
export {
  decodeAppFeatureConfig,
  snapshotAppFeatureEnv,
} from "./app-feature-selection.ts";

const conflictFromCause = (
  cause: Cause.Cause<AppFeatureError>,
): AppFeatureMutationConflictError | undefined => {
  const failure = Cause.findErrorOption(cause);
  if (failure._tag === "Some" && failure.value instanceof AppFeatureMutationConflictError)
    return failure.value;
  const defect = Result.getSuccess(Cause.findDefect(cause));
  if (defect._tag === "Some" && defect.value instanceof AppFeatureMutationConflictError) return defect.value;
  return undefined;
};
const hasExplicitTrigger = (feature: AppFeatureDefinition): boolean => {
  const services = feature.activatedBy?.services;
  return services?.type !== undefined || services?.hasFeature !== undefined;
};
const detectCycle = (plans: readonly ActivationPlan[]): AppFeatureCycleError | undefined => {
  const indices = new Map<string, Graph.NodeIndex>();
  const graph = Graph.directed<string, undefined>((mutable) => {
    for (const plan of plans) {
      const id = plan.feature.definition.id;
      if (!indices.has(id)) indices.set(id, Graph.addNode(mutable, id));
    }
    for (const left of plans) {
      const selected = new Set(left.selectedServices);
      const source = indices.get(left.feature.definition.id);
      if (source === undefined) continue;
      for (const right of plans) {
        if (
          left.feature.definition.id === right.feature.definition.id ||
          !hasExplicitTrigger(right.feature.definition)
        )
          continue;
        if (right.triggeredByServices.some((service) => selected.has(service))) {
          const target = indices.get(right.feature.definition.id);
          if (target !== undefined) Graph.addEdge(mutable, source, target, undefined);
        }
      }
    }
  });
  const found = Graph.findCycle(graph);
  if (Option.isSome(found)) {
    const cycle = found.value.path
      .slice(0, -1)
      .map((index) => Option.getOrThrow(Graph.getNode(graph, index)));
    return new AppFeatureCycleError({
      message: `App features form a mutation cycle: ${cycle.join(" -> ")}`,
      cycle,
      remediation: "Break the mutual app-feature mutation so no two features mutate each other's triggers.",
    });
  }
  return undefined;
};
export const applyPreparedAppFeatures = Effect.fn("AppPlanner.applyPreparedFeatures")(function* (
  input: AppFeatureApplicationInput,
  prepared: PreparedAppComposition,
): Effect.fn.Return<ComposeAppFeaturesResult, AppFeatureError> {
  const activations = prepared.activations;
  const cycle = detectCycle(activations);
  if (cycle !== undefined) return yield* Effect.fail(cycle);
  const ledger = new Map<string, unknown>();
  const activatedFeatures: ActivatedAppFeature[] = [];
  const globalServices: string[] = [];
  const providerCapabilities: Array<keyof ProviderCapabilities> = [];
  for (const plan of activations) {
    const config = plan.originalDecodedConfig ?? (yield* decodeAppFeatureConfig(plan.feature));
    const applyExit = yield* Effect.exit(
      Effect.suspend(() =>
        plan.feature.definition.apply(
          makeAppFeatureContext({
            feature: plan.feature,
            composition: input,
            config,
            selectedNames: plan.selectedServices,
            ledger,
          }),
        ),
      ),
    );
    if (applyExit._tag === "Failure") {
      const conflict = conflictFromCause(applyExit.cause);
      if (conflict !== undefined) return yield* Effect.fail(conflict);
      return yield* Effect.failCause(applyExit.cause);
    }
    activatedFeatures.push({
      id: plan.feature.definition.id,
      ...(plan.feature.pluginId === undefined ? {} : { pluginId: plan.feature.pluginId }),
      priority: plan.feature.definition.priority,
      selectedServices: plan.selectedServices,
      triggeredByServices: plan.triggeredByServices,
    });
    globalServices.push(...(plan.feature.definition.requires?.globalServices ?? []));
    providerCapabilities.push(...(plan.feature.definition.requires?.providerCapabilities ?? []));
  }
  return {
    activatedFeatures,
    requires: {
      globalServices: [...new Set(globalServices)],
      providerCapabilities: [...new Set(providerCapabilities)],
    },
  };
});

export const composeAppFeatures = Effect.fn("AppPlanner.composeFeatures")(function* (
  input: ComposeAppFeaturesInput,
) {
  const result = yield* prepareAppFeatures(input);
  const failure = result.errors[0];
  if (failure !== undefined) return yield* Effect.fail(failure.error);
  const activations = [];
  for (const activation of result.prepared.activations) {
    const declared = yield* declarePreparedAppFeature(activation, input);
    for (const service of input.services) {
      const contributions = declared.contributions[service.serviceName];
      if (contributions !== undefined) service.endpoints.push(...contributions);
    }
    activations.push(declared.activation);
  }
  return yield* applyPreparedAppFeatures(input, { ...result.prepared, activations });
});
