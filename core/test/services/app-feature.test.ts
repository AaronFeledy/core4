import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import type { AppFeatureContext, AppFeatureDefinition } from "@lando/sdk/services";

import {
  type AppFeatureServiceDraft,
  type ComposeAppFeature,
  type ComposeAppFeaturesInput,
  composeAppFeatures,
} from "../../src/services/app-feature.ts";

const draft = (over: Partial<AppFeatureServiceDraft> & { serviceName: string }): AppFeatureServiceDraft => ({
  serviceName: over.serviceName,
  serviceType: over.serviceType ?? "node",
  base: over.base ?? "lando",
  framework: over.framework,
  featureIds: over.featureIds ?? [],
  normalizedConfig: over.normalizedConfig ?? {},
  name: over.serviceName as AppFeatureServiceDraft["name"],
  type: over.serviceType ?? "node",
  provider: (over.provider ?? "test") as AppFeatureServiceDraft["provider"],
  primary: over.primary ?? false,
  environment: over.environment ?? {},
  mounts: over.mounts ?? [],
  buildSteps: over.buildSteps ?? [],
  storage: over.storage ?? [],
  endpoints: over.endpoints ?? [],
  dependsOn: over.dependsOn ?? [],
  hostAliases: over.hostAliases ?? [],
});

const feature = (
  definition: AppFeatureDefinition,
  config?: Readonly<Record<string, unknown>>,
): ComposeAppFeature => ({ id: definition.id, definition, ...(config === undefined ? {} : { config }) });

const inputFor = (
  services: ReadonlyArray<AppFeatureServiceDraft>,
  features: ReadonlyArray<ComposeAppFeature>,
  over?: Partial<ComposeAppFeaturesInput>,
): ComposeAppFeaturesInput => ({
  appName: "myapp",
  appRoot: "/srv/apps/myapp",
  services,
  features,
  ...over,
});

const run = (input: ComposeAppFeaturesInput) => Effect.runPromise(composeAppFeatures(input));
const runExit = (input: ComposeAppFeaturesInput) => Effect.runPromiseExit(composeAppFeatures(input));

describe("composeAppFeatures activation gating", () => {
  test("an activated feature mutates selected service drafts in place", async () => {
    const services = [draft({ serviceName: "php", serviceType: "php" }), draft({ serviceName: "node" })];
    const smtp: AppFeatureDefinition = {
      id: "mailpit.smtp",
      priority: 100,
      activatedBy: { services: { type: "php" } },
      selectors: { types: ["php"] },
      apply: (ctx) =>
        Effect.sync(() => {
          ctx.forEachSelected((service) => service.addEnv("MAIL_HOST", "mailpit.global.internal"));
        }),
    };

    const result = await run(inputFor(services, [feature(smtp)]));

    expect(services[0]?.environment.MAIL_HOST).toBe("mailpit.global.internal");
    expect(services[1]?.environment.MAIL_HOST).toBeUndefined();
    expect(result.activatedFeatures.map((f) => f.id)).toEqual(["mailpit.smtp"]);
    expect(result.activatedFeatures[0]?.selectedServices).toEqual(["php"]);
  });

  test("a no-match feature is a true no-op: no mutation, no activated entry", async () => {
    const services = [draft({ serviceName: "node" })];
    const calls: string[] = [];
    const phpOnly: AppFeatureDefinition = {
      id: "php-only",
      priority: 100,
      activatedBy: { services: { type: "php" } },
      selectors: { types: ["php"] },
      apply: (ctx) =>
        Effect.sync(() => {
          calls.push("applied");
          ctx.forEachSelected((service) => service.addEnv("X", "1"));
        }),
    };

    const result = await run(inputFor(services, [feature(phpOnly)]));

    expect(calls).toEqual([]);
    expect(services[0]?.environment.X).toBeUndefined();
    expect(result.activatedFeatures).toEqual([]);
  });

  test("omitted activatedBy means active; activatedBy.services AND's type with hasFeature", async () => {
    const services = [
      draft({ serviceName: "php", serviceType: "php", featureIds: ["lando.app-mount"] }),
      draft({ serviceName: "php2", serviceType: "php", featureIds: [] }),
    ];
    const both: AppFeatureDefinition = {
      id: "both",
      priority: 100,
      activatedBy: { services: { type: "php", hasFeature: "lando.app-mount" } },
      selectors: { names: ["php", "php2"] },
      apply: (ctx) =>
        Effect.sync(() => {
          ctx.forEachSelected((service) => service.addEnv("BOTH", "1"));
        }),
    };

    const result = await run(inputFor(services, [feature(both)]));

    expect(result.activatedFeatures.map((f) => f.id)).toEqual(["both"]);
    expect(services[0]?.environment.BOTH).toBe("1");
    expect(services[1]?.environment.BOTH).toBe("1");
  });
});

describe("composeAppFeatures selectors", () => {
  test("omitted selectors selects all drafts", async () => {
    const services = [draft({ serviceName: "a" }), draft({ serviceName: "b" })];
    const all: AppFeatureDefinition = {
      id: "all",
      priority: 100,
      apply: (ctx) => Effect.sync(() => ctx.forEachSelected((s) => s.addEnv("ALL", "1"))),
    };

    const result = await run(inputFor(services, [feature(all)]));

    expect(result.activatedFeatures[0]?.selectedServices).toEqual(["a", "b"]);
    expect(services.every((s) => s.environment.ALL === "1")).toBe(true);
  });

  test("selector clauses union; order preserved; names de-duplicated", async () => {
    const services = [
      draft({ serviceName: "php", serviceType: "php", framework: "drupal" }),
      draft({ serviceName: "worker", serviceType: "node", framework: "drupal" }),
      draft({ serviceName: "cache", serviceType: "redis" }),
    ];
    const f: AppFeatureDefinition = {
      id: "union",
      priority: 100,
      selectors: { types: ["php"], framework: ["drupal"], names: ["php"] },
      apply: (ctx) => Effect.sync(() => ctx.forEachSelected((s) => s.addEnv("U", "1"))),
    };

    const result = await run(inputFor(services, [feature(f)]));

    expect(result.activatedFeatures[0]?.selectedServices).toEqual(["php", "worker"]);
  });

  test("hasFeature selector matches drafts whose feature set contains the id", async () => {
    const services = [
      draft({ serviceName: "php", featureIds: ["lando.app-mount"] }),
      draft({ serviceName: "node", featureIds: [] }),
    ];
    const f: AppFeatureDefinition = {
      id: "by-feature",
      priority: 100,
      selectors: { hasFeature: ["lando.app-mount"] },
      apply: (ctx) => Effect.sync(() => ctx.forEachSelected((s) => s.addEnv("HF", "1"))),
    };

    const result = await run(inputFor(services, [feature(f)]));

    expect(result.activatedFeatures[0]?.selectedServices).toEqual(["php"]);
  });

  test("activated feature whose selector matches nothing raises SelectorMatchedNothing", async () => {
    const services = [draft({ serviceName: "node" })];
    const f: AppFeatureDefinition = {
      id: "empty",
      priority: 100,
      selectors: { types: ["php"] },
      apply: (ctx) => Effect.sync(() => ctx.forEachSelected((s) => s.addEnv("E", "1"))),
    };

    const exit = await runExit(inputFor(services, [feature(f)]));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("SelectorMatchedNothing");
    }
  });

  test("fromConfig resolves service names through the expression engine", async () => {
    const services = [
      draft({ serviceName: "php", normalizedConfig: { type: "php" } }),
      draft({
        serviceName: "smtp",
        serviceType: "mailpit",
        normalizedConfig: { type: "mailpit", environment: {} },
      }),
    ];
    const f: AppFeatureDefinition = {
      id: "from-config",
      priority: 100,
      selectors: { fromConfig: "{{ services.smtp.config.targets }}" },
      apply: (ctx) => Effect.sync(() => ctx.forEachSelected((s) => s.addEnv("FC", "1"))),
    };
    const resolveFromConfig: ComposeAppFeaturesInput["resolveFromConfig"] = () => Effect.succeed(["php"]);

    const result = await run(inputFor(services, [feature(f)], { resolveFromConfig }));

    expect(result.activatedFeatures[0]?.selectedServices).toEqual(["php"]);
    expect(services[0]?.environment.FC).toBe("1");
  });
});

describe("composeAppFeatures idempotency and conflicts", () => {
  test("re-applying the same env value is idempotent", async () => {
    const services = [draft({ serviceName: "php", serviceType: "php" })];
    const f: AppFeatureDefinition = {
      id: "idem",
      priority: 100,
      selectors: { types: ["php"] },
      apply: (ctx) =>
        Effect.sync(() => {
          ctx.forEachSelected((s) => {
            s.addEnv("K", "v");
            s.addEnv("K", "v");
          });
        }),
    };

    const exit = await runExit(inputFor(services, [feature(f)]));

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(services[0]?.environment.K).toBe("v");
  });

  test("divergent env writes across features raise MutationConflict", async () => {
    const services = [draft({ serviceName: "php", serviceType: "php" })];
    const a: AppFeatureDefinition = {
      id: "a",
      priority: 100,
      selectors: { types: ["php"] },
      apply: (ctx) => Effect.sync(() => ctx.forEachSelected((s) => s.addEnv("K", "one"))),
    };
    const b: AppFeatureDefinition = {
      id: "b",
      priority: 200,
      selectors: { types: ["php"] },
      apply: (ctx) => Effect.sync(() => ctx.forEachSelected((s) => s.addEnv("K", "two"))),
    };

    const exit = await runExit(inputFor(services, [feature(a), feature(b)]));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("MutationConflict");
    }
  });

  test("a pre-existing stage-3 env value is not treated as a conflict", async () => {
    const services = [draft({ serviceName: "php", serviceType: "php", environment: { K: "stage3" } })];
    const f: AppFeatureDefinition = {
      id: "overwrite",
      priority: 100,
      selectors: { types: ["php"] },
      apply: (ctx) => Effect.sync(() => ctx.forEachSelected((s) => s.addEnv("K", "feature"))),
    };

    const exit = await runExit(inputFor(services, [feature(f)]));

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(services[0]?.environment.K).toBe("feature");
  });
});

describe("composeAppFeatures cycle detection", () => {
  test("A<->B mutual mutation is rejected with AppFeatureCycleError", async () => {
    const services = [
      draft({ serviceName: "alpha", serviceType: "alpha" }),
      draft({ serviceName: "beta", serviceType: "beta" }),
    ];
    const a: AppFeatureDefinition = {
      id: "feat-a",
      priority: 100,
      activatedBy: { services: { type: "alpha" } },
      selectors: { types: ["beta"] },
      apply: (ctx) => Effect.sync(() => ctx.forEachSelected((s) => s.addEnv("A", "1"))),
    };
    const b: AppFeatureDefinition = {
      id: "feat-b",
      priority: 200,
      activatedBy: { services: { type: "beta" } },
      selectors: { types: ["alpha"] },
      apply: (ctx) => Effect.sync(() => ctx.forEachSelected((s) => s.addEnv("B", "1"))),
    };

    const exit = await runExit(inputFor(services, [feature(a), feature(b)]));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("CycleDetected");
      if (exit.cause.error._tag === "CycleDetected") {
        expect(exit.cause.error.cycle).toContain("feat-a");
        expect(exit.cause.error.cycle).toContain("feat-b");
      }
    }
  });

  test("a feature that mutates its own trigger service is not a cycle", async () => {
    const services = [draft({ serviceName: "php", serviceType: "php" })];
    const f: AppFeatureDefinition = {
      id: "self",
      priority: 100,
      activatedBy: { services: { type: "php" } },
      selectors: { types: ["php"] },
      apply: (ctx) => Effect.sync(() => ctx.forEachSelected((s) => s.addEnv("S", "1"))),
    };

    const exit = await runExit(inputFor(services, [feature(f)]));

    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("composeAppFeatures requires aggregation", () => {
  test("aggregates requires.globalServices and providerCapabilities across activated features (dedup, deterministic)", async () => {
    const services = [draft({ serviceName: "php", serviceType: "php" })];
    const mailpit: AppFeatureDefinition = {
      id: "mailpit",
      priority: 100,
      selectors: { types: ["php"] },
      requires: { globalServices: ["mailpit"], providerCapabilities: ["sharedCrossAppNetwork"] },
      apply: (ctx) => Effect.sync(() => ctx.forEachSelected((s) => s.addEnv("MAIL", "1"))),
    };
    const tracing: AppFeatureDefinition = {
      id: "tracing",
      priority: 200,
      selectors: { types: ["php"] },
      requires: { globalServices: ["mailpit", "otel"] },
      apply: (ctx) => Effect.sync(() => ctx.forEachSelected((s) => s.addEnv("OTEL", "1"))),
    };

    const result = await run(inputFor(services, [feature(mailpit), feature(tracing)]));

    expect(result.requires.globalServices).toEqual(["mailpit", "otel"]);
    expect(result.requires.providerCapabilities).toEqual(["sharedCrossAppNetwork"]);
  });

  test("an inactive feature does not contribute to requires", async () => {
    const services = [draft({ serviceName: "node" })];
    const phpOnly: AppFeatureDefinition = {
      id: "php-only",
      priority: 100,
      activatedBy: { services: { type: "php" } },
      selectors: { types: ["php"] },
      requires: { globalServices: ["mailpit"] },
      apply: (ctx) => Effect.sync(() => ctx.forEachSelected((s) => s.addEnv("X", "1"))),
    };

    const result = await run(inputFor(services, [feature(phpOnly)]));

    expect(result.requires.globalServices).toEqual([]);
  });
});

describe("composeAppFeatures ordering and schema decode", () => {
  test("activated features run in ascending priority, then stable registration index", async () => {
    const services = [draft({ serviceName: "php", serviceType: "php" })];
    const order: string[] = [];
    const mk = (id: string, priority: number): AppFeatureDefinition => ({
      id,
      priority,
      selectors: { types: ["php"] },
      apply: (ctx: AppFeatureContext) =>
        Effect.sync(() => {
          order.push(id);
          ctx.forEachSelected((s) => s.addEnv(id, "1"));
        }),
    });

    await run(inputFor(services, [feature(mk("late", 200)), feature(mk("early", 100))]));

    expect(order).toEqual(["early", "late"]);
  });
});
