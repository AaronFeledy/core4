import { expect, test } from "bun:test";
import { composeService } from "@lando/engine/services/feature";
import { ProviderId, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { serviceFeatures } from "../src/features/index.ts";

for (const mode of ["sidecar", "host"] as const) {
  test(`records ${mode} as a service extension without mounts or environment`, async () => {
    // Given
    const definition = serviceFeatures.get("lando.ssh-agent");
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
        appRoot: "/apps/ssh-test",
        normalizedConfig: {},
        features: [{ id: definition.id, definition, config: { mode } }],
      }),
    );
    // Then
    expect(definition.priority).toBe(1200);
    expect(definition.requires).toEqual(["agentSocket"]);
    expect(plan.extensions["@lando/core/ssh-agent"]).toEqual({ mode });
    expect(plan.mounts).toEqual([]);
    expect(plan.environment).toEqual({});
  });
}
