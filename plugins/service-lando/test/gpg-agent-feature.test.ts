import { expect, test } from "bun:test";
import { composeService } from "@lando/engine/services/feature";
import { ProviderId, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { serviceFeatures } from "../src/features/index.ts";

test("gpg feature records opt-in without adding a build step or overriding the service user", async () => {
  // Given
  const definition = serviceFeatures.get("lando.gpg-agent");
  expect(definition).toBeDefined();
  if (definition === undefined) return;
  // When
  const plan = await Effect.runPromise(
    composeService({
      base: {
        name: ServiceName.make("web"),
        type: "lando",
        provider: ProviderId.make("lando"),
        primary: true,
        defaultFeatures: [],
      },
      baseKind: "lando",
      appRoot: "/apps/gpg",
      normalizedConfig: { user: "1000" },
      features: [{ id: definition.id, definition }],
    }),
  );
  // Then
  expect(definition.priority).toBe(1210);
  expect(plan.extensions["@lando/core/gpg-agent"]).toEqual({ forward: true });
  expect(plan.extensions["@lando/core/service-features"]).toMatchObject({
    featureIds: ["lando.gpg-agent"],
  });
  expect(plan.extensions["@lando/core/service-features"]).not.toHaveProperty("buildSteps");
  expect(JSON.stringify(plan.extensions)).not.toContain('"user":"root"');
});
