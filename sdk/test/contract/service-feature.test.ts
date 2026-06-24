import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import type { ServiceFeatureContext, ServiceFeatureDefinition } from "@lando/sdk/services";

describe("ServiceFeature contract surface", () => {
  test("a ServiceFeatureDefinition is satisfiable with intent-only apply", () => {
    const feature: ServiceFeatureDefinition = {
      id: "test.feature",
      priority: 100,
      schema: Schema.Unknown,
      apply: (ctx: ServiceFeatureContext) =>
        Effect.sync(() => {
          ctx.addEnv("LANDO_TEST", "1");
          ctx.addMount({ type: "bind", source: "/host", target: "/app", readOnly: false });
          ctx.addBuildStep({ phase: "build", command: ["echo", "hi"] });
        }),
    };

    expect(feature.id).toBe("test.feature");
    expect(feature.priority).toBe(100);
    expect(typeof feature.apply).toBe("function");
  });

  test("apply may fail with ServiceFeatureError", () => {
    const feature: ServiceFeatureDefinition = {
      id: "test.failing",
      priority: 50,
      apply: () => Effect.fail(new ServiceFeatureError({ message: "nope", feature: "test.failing" })),
    };
    expect(typeof feature.apply).toBe("function");
  });

  test("the context surface exposes no provider/capability/draft accessor", () => {
    // Compile-time probes: each of these accessors must NOT exist on the
    // published context surface. A regression that adds one breaks typecheck.
    type Ctx = ServiceFeatureContext;
    type HasProviderId = "providerId" extends keyof Ctx ? true : false;
    type HasProvider = "provider" extends keyof Ctx ? true : false;
    type HasCapabilities = "capabilities" extends keyof Ctx ? true : false;
    type HasDraft = "draft" extends keyof Ctx ? true : false;

    const noProviderId: HasProviderId = false;
    const noProvider: HasProvider = false;
    const noCapabilities: HasCapabilities = false;
    const noDraft: HasDraft = false;

    expect(noProviderId).toBe(false);
    expect(noProvider).toBe(false);
    expect(noCapabilities).toBe(false);
    expect(noDraft).toBe(false);
  });

  test("mount intent types omit the realization decision", () => {
    // A mount intent must NOT carry `realization`; features emit intent only.
    type MountIntent = Parameters<ServiceFeatureContext["addMount"]>[0];
    type HasRealization = "realization" extends keyof MountIntent ? true : false;
    const noRealization: HasRealization = false;
    expect(noRealization).toBe(false);

    type AppMountIntent = Parameters<ServiceFeatureContext["setAppMount"]>[0];
    type AppHasRealization = "realization" extends keyof AppMountIntent ? true : false;
    const appNoRealization: AppHasRealization = false;
    expect(appNoRealization).toBe(false);
  });
});
