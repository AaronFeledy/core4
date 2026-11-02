import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest, ServiceName } from "@lando/sdk/schema";
import {
  type AppFeatureDefinition,
  AppPlanner,
  type ServiceFeatureDefinition,
  type ServiceType,
} from "@lando/sdk/services";
import { PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import { bundledPluginModules } from "../../src/composition.ts";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as Plugins from "../../src/plugins/registry.ts";
import { lintLandofileSnapshot } from "../../src/services/landofile-live.ts";
import * as Planner from "../../src/services/planner.ts";

const capabilities = { ...TestRuntimeProvider.capabilities, serviceInit: false };
const cases = [
  ["service", false],
  ["service", true],
  ["app", false],
  ["app", true],
] as const;

const featureRegistry = (source: "service" | "app", init: boolean, calls: string[]) => {
  const serviceFeature: ServiceFeatureDefinition = {
    id: "test.service-init",
    priority: 100,
    apply: (ctx) =>
      Effect.sync(() => {
        calls.push("service");
        ctx.setInit(init);
      }),
  };
  const appFeature: AppFeatureDefinition = {
    id: "test.app-init",
    priority: 100,
    selectors: { names: ["web"] },
    apply: (ctx) =>
      Effect.sync(() => {
        calls.push("app");
        ctx.forEachSelected((service) => service.setInit(init));
      }),
  };
  const type: ServiceType = {
    id: "test-init",
    name: "test-init",
    base: init ? "l337" : "lando",
    schema: Schema.Unknown,
    resolve: ({ service }) =>
      Effect.succeed({
        base: init ? "l337" : "lando",
        normalizedConfig: service,
        features: source === "service" ? [{ id: serviceFeature.id }] : [],
      }),
  };
  const plugin = definePlugin({
    name: "@test/init-lint",
    manifest: Schema.decodeUnknownSync(PluginManifest)({
      name: "@test/init-lint",
      version: "1.0.0",
      api: 4,
      contributes: {
        serviceTypes: [type.id],
        serviceFeatures: source === "service" ? [serviceFeature.id] : [],
        appFeatures: source === "app" ? [appFeature.id] : [],
      },
    }),
    serviceTypes: new Map([[type.id, type]]),
    serviceFeatures: new Map(source === "service" ? [[serviceFeature.id, serviceFeature]] : []),
    appFeatures: new Map(source === "app" ? [[appFeature.id, appFeature]] : []),
  });
  return Plugins.layerWith({ app: false, user: false }, [...bundledPluginModules(), plugin]);
};

test.each(cases)("lint defers %s feature init=%s to fail-closed final planning", async (source, init) => {
  const root = await mkdtemp(join(tmpdir(), "lando-feature-init-lint-"));
  const calls: string[] = [];
  const registry = featureRegistry(source, init, calls);
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: feature-init\nservices:\n  web:\n    type: test-init\n    image: alpine\n    home: false\n    appMount: false\n",
    );
    const linted = await Effect.runPromise(
      Effect.flatMap(PluginRegistry, (original) =>
        appConfigLint({ cwd: root }).pipe(
          Effect.provideService(PluginRegistry, {
            ...original,
            declaredProviderCapabilities: () => capabilities,
          }),
        ),
      ).pipe(Effect.provide(registry)),
    );
    expect(linted.valid).toBe(true);
    expect(linted.violations.filter((issue) => issue.path.join(".") === "services.web.init")).toMatchObject([
      { severity: "warning", rule: "landofile.capability" },
    ]);
    expect(calls).toEqual([]);

    const snapshot = await Effect.runPromise(lintLandofileSnapshot({ cwd: root }));
    if (snapshot.resolved === undefined) throw new Error("Expected resolved snapshot");
    const landofile = snapshot.resolved;
    const planned = await Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities)).pipe(
        Effect.result,
        Effect.provide(Planner.layer),
        Effect.provide(registry),
      ),
    );
    expect(calls).toEqual([source]);
    if (init) {
      expect(Result.isFailure(planned)).toBe(true);
      if (Result.isFailure(planned))
        expect(planned.failure).toMatchObject({ _tag: "CapabilityError", capability: "serviceInit" });
    } else {
      expect(Result.isSuccess(planned)).toBe(true);
      if (Result.isSuccess(planned))
        expect(planned.success.services[ServiceName.make("web")]?.init).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(cases)(
  "authored init opposes %s feature init=%s in lint and planning",
  async (source, contribution) => {
    const init = !contribution;
    const root = await mkdtemp(join(tmpdir(), "lando-authored-init-lint-"));
    const calls: string[] = [];
    const registry = featureRegistry(source, contribution, calls);
    try {
      await writeFile(
        join(root, ".lando.yml"),
        `name: authored-init\nservices:\n  web:\n    type: test-init\n    image: alpine\n    home: false\n    appMount: false\n    init: ${init}\n`,
      );
      const linted = await Effect.runPromise(
        Effect.flatMap(PluginRegistry, (original) =>
          appConfigLint({ cwd: root }).pipe(
            Effect.provideService(PluginRegistry, {
              ...original,
              declaredProviderCapabilities: () => capabilities,
            }),
          ),
        ).pipe(Effect.provide(registry)),
      );
      expect(linted.valid).toBe(!init);
      expect(
        linted.violations
          .filter((issue) => issue.path.join(".") === "services.web.init")
          .map((issue) => issue.severity),
      ).toEqual(init ? ["error"] : []);
      expect(calls).toEqual([]);

      const snapshot = await Effect.runPromise(lintLandofileSnapshot({ cwd: root }));
      if (snapshot.resolved === undefined) throw new Error("Expected resolved snapshot");
      const landofile = snapshot.resolved;
      const planned = await Effect.runPromise(
        Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities)).pipe(
          Effect.result,
          Effect.provide(Planner.layer),
          Effect.provide(registry),
        ),
      );
      expect(calls).toEqual([source]);
      if (init) {
        expect(Result.isFailure(planned)).toBe(true);
        if (Result.isFailure(planned))
          expect(planned.failure).toMatchObject({ _tag: "CapabilityError", capability: "serviceInit" });
      } else {
        expect(Result.isSuccess(planned)).toBe(true);
        if (Result.isSuccess(planned))
          expect(planned.success.services[ServiceName.make("web")]?.init).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
