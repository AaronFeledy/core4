import { expect, test } from "bun:test";
import { ProviderId, ServiceName } from "@lando/sdk/schema";
import type { AppFeatureDefinition } from "@lando/sdk/services";
import { Cause, Effect, Exit, Option } from "effect";
import { type AppFeatureServiceDraft, composeAppFeatures } from "../../src/services/app-feature.ts";

for (const [first, second, conflict] of [
  [undefined, undefined, false],
  [null, null, false],
  [undefined, null, true],
  [null, undefined, true],
  [{ a: 1, B: 2, "10": 3, "2": 4 }, { "2": 4, "10": 3, B: 2, a: 1 }, false],
  [["one", "two"], ["two", "one"], true],
] as const) {
  test(`preserves mutation equality for ${JSON.stringify(first)} versus ${JSON.stringify(second)}`, async () => {
    const draft: AppFeatureServiceDraft = {
      serviceName: "web",
      serviceType: "node",
      base: "lando",
      featureIds: [],
      normalizedConfig: {},
      name: ServiceName.make("web"),
      type: "node",
      provider: ProviderId.make("test"),
      primary: true,
      environment: {},
      mounts: [],
      buildSteps: [],
      storage: [],
      endpoints: [],
      dependsOn: [],
      hostAliases: [],
    };
    const features = [first, second].map((value, index) => {
      const id = `feature-${index}`;
      const definition: AppFeatureDefinition = {
        id,
        priority: index,
        apply: (ctx) =>
          Effect.sync(() =>
            ctx.forEachSelected((service) => {
              Reflect.apply(service.setCommand, service, [value]);
            }),
          ),
      };
      return { id, definition };
    });
    const exit = await Effect.runPromiseExit(
      composeAppFeatures({ appRoot: "/app", services: [draft], features }),
    );
    expect(Exit.isFailure(exit)).toBe(conflict);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))._tag).toBe("MutationConflict");
    }
  });
}
