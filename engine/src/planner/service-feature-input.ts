import type { FeatureRef, PluginRegistry, ServiceTypeResolution } from "@lando/sdk/services";
import { type Context, Effect } from "effect";
import type { ComposeServiceFeature } from "../services/feature.ts";
import { baseDefaultFeatureIds } from "./service-types.ts";

export const declaredServiceFeatures = (resolution: ServiceTypeResolution, gpgForward: boolean) => {
  const explicitIds = new Set(resolution.features.map((feature) => feature.id));
  const baseDefaultIds = baseDefaultFeatureIds(resolution.base).filter((id) => !explicitIds.has(id));
  return {
    baseDefaultIds,
    featureRefs: [
      ...(resolution.base === "lando" && gpgForward ? [{ id: "lando.gpg-agent" }] : []),
      ...baseDefaultIds.map((id) => ({ id })),
      ...resolution.features,
    ],
  };
};

export const loadServiceFeatures = Effect.fnUntraced(function* (
  registry: Context.Service.Shape<typeof PluginRegistry>,
  input: { readonly baseDefaultIds: readonly string[]; readonly featureRefs: readonly FeatureRef[] },
) {
  const configured = input.featureRefs.filter(
    (ref) => !input.baseDefaultIds.includes(ref.id) || ref.config !== undefined,
  );
  const configuredIds = new Set(configured.map((ref) => ref.id));
  const features = yield* Effect.forEach(configured, (ref) =>
    registry.loadServiceFeature(ref.id).pipe(
      Effect.map(
        (definition): ComposeServiceFeature => ({
          id: ref.id,
          definition,
          ...(ref.config === undefined ? {} : { config: ref.config }),
        }),
      ),
    ),
  );
  const defaultFeatures = yield* Effect.forEach(
    input.baseDefaultIds.filter((id) => !configuredIds.has(id)),
    (id) => registry.loadServiceFeature(id),
  );
  return { features, defaultFeatures };
});
