import type { PluginManifest } from "@lando/sdk/schema";
import type { LandofileShape } from "@lando/sdk/schema";
import type { PluginRegistry } from "@lando/sdk/services";
import { type Context, Effect, Result } from "effect";
import {
  type PreparedAppFeature,
  declarePreparedAppFeature,
  prepareAppFeatures,
} from "../services/app-feature-preparation.ts";
import {
  orderAppFeatures,
  selectAppFeatureServices,
  snapshotAppFeatureEnv,
} from "../services/app-feature-selection.ts";
import type { ComposeAppFeature } from "../services/app-feature-types.ts";
import { type ServiceEndpointProjection, blockContributions } from "./endpoint-availability.ts";
import { type PlannerIssue, attributePlannerIssue } from "./resolved-validation.ts";
import { appFeatureError, contributionId } from "./service-types.ts";

export const declareAppEndpoints = Effect.fnUntraced(function* (input: {
  readonly rows: Map<string, ServiceEndpointProjection>;
  readonly landofile: LandofileShape;
  readonly manifests: readonly PluginManifest[];
  readonly pluginRegistry: Context.Service.Shape<typeof PluginRegistry>;
  readonly appName: string;
  readonly appRoot: string;
  readonly env: Readonly<Record<string, string>>;
}) {
  const appFeatures: ComposeAppFeature[] = [];
  const issues: PlannerIssue[] = [];
  const allNames = [...input.rows.keys()];
  const record = (error: unknown) => {
    const reasons = appFeatureError(input.appRoot, error).issues.map((issue) =>
      attributePlannerIssue(input.landofile, { ...issue, rule: "landofile.service" }),
    );
    issues.push(...reasons);
    return reasons;
  };
  const seen = new Set<string>();
  for (const manifest of input.manifests) {
    for (const entry of manifest.contributes?.appFeatures ?? []) {
      const id = contributionId(entry);
      if (seen.has(id)) continue;
      seen.add(id);
      const loaded = yield* input.pluginRegistry.loadAppFeature(id).pipe(Effect.result);
      if (Result.isFailure(loaded)) {
        blockContributions(input.rows, allNames, record(loaded.failure));
        continue;
      }
      appFeatures.push({ id, definition: loaded.success, pluginId: manifest.name });
    }
  }
  const services = [...input.rows.values()].flatMap((row) =>
    row.preparation._tag === "Available" ? [row.preparation.value.view] : [],
  );
  const missingReasons = [...input.rows.values()].flatMap((row) =>
    row.preparation._tag === "Unavailable" ? row.preparation.reasons : [],
  );
  const selectionInput = {
    appName: input.appName,
    appRoot: input.appRoot,
    services,
    features: appFeatures,
    env: input.env,
  };
  // An incomplete service context cannot establish activation or dynamic selection.
  if (services.length !== input.rows.size) {
    const features = orderAppFeatures(appFeatures);
    const environment = snapshotAppFeatureEnv(features, input.env);
    for (const feature of features) {
      if (feature.definition.declareEndpoints === undefined) continue;
      if (feature.definition.selectors?.fromConfig !== undefined) {
        blockContributions(input.rows, allNames, missingReasons);
      } else {
        const selected = yield* selectAppFeatureServices(feature, {
          ...selectionInput,
          env: environment.env,
        }).pipe(Effect.result);
        if (Result.isSuccess(selected)) blockContributions(input.rows, selected.success, missingReasons);
        else blockContributions(input.rows, allNames, record(selected.failure));
      }
    }
    return { prepared: { features, environment, activations: [] }, issues };
  }
  const result = yield* prepareAppFeatures(selectionInput);
  for (const failure of result.errors) {
    const reasons = record(failure.error);
    const names = failure.feature.definition.selectors?.fromConfig === undefined ? [] : allNames;
    blockContributions(input.rows, names, reasons);
  }
  const activations: PreparedAppFeature[] = [];
  for (const activation of result.prepared.activations) {
    const declared = yield* declarePreparedAppFeature(activation, selectionInput).pipe(Effect.result);
    if (Result.isFailure(declared)) {
      blockContributions(input.rows, activation.selectedServices, record(declared.failure));
      continue;
    }
    activations.push(declared.success.activation);
    for (const name of activation.selectedServices) {
      const row = input.rows.get(name);
      const added = declared.success.contributions[name];
      if (row === undefined || row.contributions._tag === "Unavailable" || added === undefined) continue;
      input.rows.set(name, {
        ...row,
        contributions: { _tag: "Available", value: [...row.contributions.value, ...added] },
      });
    }
  }
  return { prepared: { ...result.prepared, activations }, issues };
});
