import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition } from "@lando/sdk/services";
import { type BaseSeed, type ComposeServiceInput, composeService } from "../../src/services/feature.ts";

const base: BaseSeed = {
  name: ServiceName.make("appserver"),
  type: "node",
  provider: ProviderId.make("test"),
  primary: true,
  environment: { FROM_BASE: "yes" },
  defaultFeatures: [],
};

const inputFor = (features: ReadonlyArray<ServiceFeatureDefinition>): ComposeServiceInput => ({
  base: { ...base, defaultFeatures: [] },
  baseKind: "lando",
  appRoot: "/tmp/lando-app",
  normalizedConfig: {},
  features: features.map((definition) => ({ id: definition.id, definition })),
});

const composeOnce = (features: ReadonlyArray<ServiceFeatureDefinition>): Promise<ServicePlan> =>
  Effect.runPromise(composeService(inputFor(features)));

describe("composeService", () => {
  test("applies features in stable ascending priority order", async () => {
    const calls: string[] = [];
    const later: ServiceFeatureDefinition = {
      id: "feature.later",
      priority: 200,
      apply: (ctx) =>
        Effect.sync(() => {
          calls.push("later");
          ctx.addEnv("ORDER", `${ctx.config.label}`);
        }),
    };
    const earlier: ServiceFeatureDefinition = {
      id: "feature.earlier",
      priority: 100,
      apply: (ctx) =>
        Effect.sync(() => {
          calls.push("earlier");
          ctx.addEnv("FIRST", `${ctx.serviceName}:${ctx.serviceType}:${ctx.base}`);
        }),
    };

    const plan = await Effect.runPromise(
      composeService({
        ...inputFor([]),
        features: [
          { id: later.id, config: { label: "second" }, definition: later },
          { id: earlier.id, definition: earlier },
        ],
      }),
    );

    expect(calls).toEqual(["earlier", "later"]);
    expect(plan.environment).toEqual({ FIRST: "appserver:node:lando", FROM_BASE: "yes", ORDER: "second" });
  });

  test("emits feature env, mounts, and build-step intent", async () => {
    const feature: ServiceFeatureDefinition = {
      id: "feature.plan-intent",
      priority: 100,
      apply: (ctx) =>
        Effect.sync(() => {
          ctx.addEnv("NODE_ENV", "development");
          ctx.addMount({ type: "bind", source: "/host/cache", target: "/cache", readOnly: false });
          ctx.addBuildStep({
            id: "install",
            phase: "build",
            command: ["bun", "install"],
            dependsOn: ["prepare"],
          });
        }),
    };

    const plan = await composeOnce([feature]);

    expect(plan.environment).toEqual({ FROM_BASE: "yes", NODE_ENV: "development" });
    expect(plan.mounts).toEqual([
      { type: "bind", source: "/host/cache", target: "/cache", readOnly: false, realization: "passthrough" },
    ]);
    expect(plan.mounts.every((mount) => mount.realization === "passthrough")).toBe(true);
    expect(plan.extensions).toEqual({
      "@lando/core/service-features": {
        buildSteps: [{ id: "install", phase: "build", command: ["bun", "install"], dependsOn: ["prepare"] }],
      },
    });
  });

  test("is byte-identical when replayed with identical inputs", async () => {
    const feature: ServiceFeatureDefinition = {
      id: "feature.deterministic",
      priority: 100,
      apply: (ctx) =>
        Effect.sync(() => {
          ctx.addEnv("B", "2");
          ctx.addEnv("A", "1");
          ctx.addEndpoint({ name: "http", protocol: "http", port: 80 });
        }),
    };

    const first = JSON.stringify(await composeOnce([feature]));
    const second = JSON.stringify(await composeOnce([feature]));

    expect(first).toBe(second);
  });

  test("fails with the feature's ServiceFeatureError", async () => {
    const feature: ServiceFeatureDefinition = {
      id: "feature.fail",
      priority: 100,
      apply: () => Effect.fail(new ServiceFeatureError({ message: "boom", feature: "feature.fail" })),
    };

    const exit = await Effect.runPromiseExit(composeService(inputFor([feature])));

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(exit.cause._tag).toBe("Fail");
      if (exit.cause._tag === "Fail") {
        expect(exit.cause.error._tag).toBe("ServiceFeatureError");
        expect(exit.cause.error.feature).toBe("feature.fail");
      }
    }
  });
});
