import { expect, test } from "bun:test";
import { ProviderId, ServiceName } from "@lando/sdk/schema";
import type { AppFeatureDefinition, ServiceTypeResolution } from "@lando/sdk/services";
import { Effect } from "effect";
import { servicePlanFromDraft, toAppFeatureDraft } from "../../src/planner/extensions.ts";
import { composeAppFeatures } from "../../src/services/app-feature.ts";
import { prepareServiceComposition } from "../../src/services/feature-preparation.ts";
import { composeService } from "../../src/services/feature.ts";

test("direct composition projects resolution facts into declarations, application and persisted provenance", async () => {
  // Given
  const metadata = Object.freeze({ "@test/runtime-policy": Object.freeze({ mode: "resolved" }) });
  const resolution: ServiceTypeResolution = { base: "l337", normalizedConfig: {}, features: [], metadata };
  const input = {
    base: {
      name: ServiceName.make("web"),
      type: "custom",
      provider: ProviderId.make("test"),
      primary: true,
      defaultFeatures: [],
    },
    baseKind: resolution.base,
    appRoot: "/srv/metadata",
    normalizedConfig: resolution.normalizedConfig,
    resolutionMetadata: metadata,
    features: [],
  };
  const seen: unknown[] = [];
  const definition: AppFeatureDefinition = {
    id: "test.metadata",
    priority: 1,
    declareEndpoints: (ctx) =>
      Effect.sync(() => {
        seen.push(ctx.selected[0]?.resolutionMetadata);
        return {};
      }),
    apply: (ctx) =>
      Effect.sync(() =>
        ctx.forEachSelected((selected) => {
          seen.push(selected.service.resolutionMetadata);
        }),
      ),
  };
  // When
  const prepared = prepareServiceComposition(input);
  const plan = await Effect.runPromise(composeService(input));
  const draft = toAppFeatureDraft("web", plan, resolution, []);
  await Effect.runPromise(
    composeAppFeatures({
      appRoot: input.appRoot,
      services: [draft],
      features: [{ id: definition.id, definition }],
    }),
  );
  // Then
  expect(prepared.view.resolutionMetadata).toBe(metadata);
  expect(servicePlanFromDraft(draft, plan.routes, plan.metadata, plan.extensions).provenance).toEqual(
    metadata,
  );
  expect(seen).toEqual([metadata, metadata]);
});
