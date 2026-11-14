import { describe, expect, test } from "bun:test";

import { AppFeatureCloneError, LandofileValidationError } from "@lando/sdk/errors";
import { definePlugin } from "@lando/sdk/plugins";
import {
  AbsoluteContainerPath,
  AbsolutePath,
  LogSourceId,
  PluginManifest,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type {
  AppFeatureDefinition,
  ClonedServiceRequest,
  ServiceBuildStepIntent,
  ServiceFeatureDefinition,
  ServiceType,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Effect, Option, Predicate, Schema } from "effect";

import { DATA_TREE_OWNERSHIP_STEP_ID } from "../../src/planner/data-tree.ts";
import { LOG_SOURCES_EXTENSION_KEY, SERVICE_FEATURES_EXTENSION_KEY } from "../../src/planner/extensions.ts";
import * as Registry from "../../src/plugins/registry.ts";
import { LANDO_BASE_DEFAULT_FEATURE_IDS } from "../../src/services/base/lando.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";
import { planApp } from "../plan-app.ts";

const cloneFeature = (request: ClonedServiceRequest): AppFeatureDefinition => ({
  id: "test.clone",
  priority: 500,
  selectors: { names: [request.from] },
  apply: (ctx) =>
    Effect.sync(() => {
      ctx.addClonedService(request);
    }),
});

const entrypointFeature: ServiceFeatureDefinition = {
  id: "test.entrypoint",
  priority: 100,
  apply: (ctx) =>
    Effect.sync(() => {
      if (ctx.normalizedConfig.entrypoint !== undefined) ctx.setEntrypoint(ctx.normalizedConfig.entrypoint);
    }),
};

const clonedServiceType: ServiceType = {
  id: "cloned",
  name: "cloned",
  base: "l337",
  schema: Schema.Unknown,
  versions: ["3.22"],
  artifacts: { "3.22": "alpine:3.22" },
  identity: {
    defaultUser: "node",
    homes: {
      node: AbsoluteContainerPath.make("/home/node"),
      root: AbsoluteContainerPath.make("/root"),
    },
  },
  resolve: ({ service }) =>
    Effect.succeed({
      base: "l337",
      normalizedConfig: service,
      features: [{ id: entrypointFeature.id }],
    }),
};

const homeServiceType: ServiceType = {
  ...clonedServiceType,
  id: "cloned-home",
  name: "cloned-home",
  identity: {
    defaultUser: "node",
    homes: {
      node: AbsoluteContainerPath.make("/home/node"),
      root: AbsoluteContainerPath.make("/root"),
      "www-data": AbsoluteContainerPath.make("/var/www"),
    },
    preparedHomes: ["node", "www-data"],
  },
};

const redirectLogServiceType: ServiceType = {
  ...clonedServiceType,
  id: "cloned-logs",
  name: "cloned-logs",
  base: "lando",
  resolve: ({ service }) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: service,
      features: [{ id: entrypointFeature.id }],
      logSources: [
        {
          id: LogSourceId.make("access"),
          path: AbsolutePath.make("/var/log/access.log"),
          stream: "stdout",
          strategy: "redirect",
          required: false,
          timestamps: false,
        },
      ],
    }),
};

/** Base lando seeds its bundled feature stack; this test supplies inert doubles for it. */
const landoBaseFeatureStubs: ReadonlyArray<ServiceFeatureDefinition> = LANDO_BASE_DEFAULT_FEATURE_IDS.map(
  (id) => ({ id, priority: 100, apply: () => Effect.void }),
);

const testServiceFeatures = new Map<string, ServiceFeatureDefinition>([
  ...landoBaseFeatureStubs.map((feature) => [feature.id, feature] as const),
  [entrypointFeature.id, entrypointFeature],
]);

const pluginFor = (feature: AppFeatureDefinition) =>
  definePlugin({
    name: "@test/cloned-service",
    manifest: Schema.decodeUnknownSync(PluginManifest)({
      name: "@test/cloned-service",
      version: "1.0.0",
      api: 4,
      entry: "index.js",
      contributes: {
        serviceTypes: [clonedServiceType.id, homeServiceType.id, redirectLogServiceType.id],
        serviceFeatures: [...LANDO_BASE_DEFAULT_FEATURE_IDS, entrypointFeature.id],
        appFeatures: [feature.id],
      },
    }),
    serviceTypes: new Map([
      [clonedServiceType.id, clonedServiceType],
      [homeServiceType.id, homeServiceType],
      [redirectLogServiceType.id, redirectLogServiceType],
    ]),
    serviceFeatures: testServiceFeatures,
    appFeatures: new Map([[feature.id, feature]]),
  });

const planWithClone = (
  document: Record<string, unknown>,
  feature: AppFeatureDefinition,
  providerCapabilities = TestRuntimeProvider.capabilities,
) =>
  Effect.gen(function* () {
    const landofile = yield* compileTestLandofile(document, "/srv/clones");
    return yield* planApp(
      { landofile, providerCapabilities },
      Registry.layerWith({ app: false, user: false }, [pluginFor(feature)]),
    );
  });

const cloneRequest: ClonedServiceRequest = {
  from: "web",
  name: "web-schedule",
  command: ["/usr/local/bin/supercronic", "/usr/local/etc/supercronic/crontab"],
};

const web = {
  type: "cloned:3.22",
  appMount: "/app",
  storage: ["/app/vendor"],
  mounts: [{ source: ".", target: "/src", excludes: ["vendor"] }],
  networks: { default: { aliases: ["db-alias"] } },
  build: { artifact: ["echo artifact"], app: ["composer install"] },
  endpoints: [{ _tag: "published", protocol: "http", port: 80, publication: { hostPort: 8099 } }],
  hostnames: ["web.example.internal"],
  routes: ["app.lndo.site"],
  healthcheck: { command: "true" },
};

const volumeStores = (service: ServicePlan): ReadonlyArray<string> =>
  service.mounts.flatMap((mount) => (mount.type === "volume" ? [mount.store] : [])).sort();

const buildSteps = (service: ServicePlan): ReadonlyArray<ServiceBuildStepIntent> => {
  const extension = service.extensions[SERVICE_FEATURES_EXTENSION_KEY];
  if (!Predicate.isObject(extension)) return [];
  const steps = extension.buildSteps;
  return Array.isArray(steps) ? (steps as ReadonlyArray<ServiceBuildStepIntent>) : [];
};

const homeStore = (service: ServicePlan): string | undefined =>
  service.home?.state === "persisted" ? service.home.store : undefined;

describe("cloned services in a planned app", () => {
  test("shares the parent's stores and gains no listeners, routes, aliases, or app build", async () => {
    const app = await Effect.runPromise(
      planWithClone({ name: "clones", services: { web } }, cloneFeature(cloneRequest)),
    );
    const parent = app.services[ServiceName.make("web")];
    const clone = app.services[ServiceName.make("web-schedule")];
    if (parent === undefined || clone === undefined) throw new Error("expected both services");
    const stores = volumeStores(parent);

    expect(stores.length).toBeGreaterThan(0);
    expect(volumeStores(clone)).toEqual(stores);
    expect(stores.some((store) => store.includes("--web--shadow--"))).toBe(true);
    expect(stores.some((store) => store.includes("--web--storage--"))).toBe(true);
    expect(homeStore(clone)).toBe(homeStore(parent));

    expect(buildSteps(parent).map((step) => step.phase)).toEqual(["build", "app"]);
    expect(buildSteps(clone).map((step) => step.phase)).toEqual(["build"]);

    expect(parent.endpoints).toContainEqual(
      expect.objectContaining({ _tag: "published", publication: { hostPort: 8099 } }),
    );
    expect(clone.endpoints).toEqual([]);
    expect(clone.routes).toEqual([]);
    expect(app.routes.map((route) => String(route.service))).toEqual(["web"]);
    expect(app.routes.some((route) => route.hostname === "app.lndo.site")).toBe(true);

    expect(app.networking?.perAppBridge?.aliases?.[ServiceName.make("web")]).toEqual(["db-alias"]);
    expect(app.networking?.perAppBridge?.aliases?.[ServiceName.make("web-schedule")]).toBeUndefined();
    expect(app.networking?.sharedNetworkMembership?.aliases[ServiceName.make("web-schedule")]).toEqual([
      "web-schedule.clones.internal",
    ]);

    expect(clone.healthcheck).toEqual({
      kind: "none",
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
    });
    expect(clone.readiness).toBeUndefined();
    expect(clone.certs).toBeUndefined();
  });

  test("runs exactly the requested command, ignoring the parent entrypoint", async () => {
    const withEntrypoint = { ...web, entrypoint: ["node", "server.js"] };
    const argvPlan = await Effect.runPromise(
      planWithClone({ name: "clones", services: { web: withEntrypoint } }, cloneFeature(cloneRequest)),
    );
    const argvParent = argvPlan.services[ServiceName.make("web")];
    const argvClone = argvPlan.services[ServiceName.make("web-schedule")];
    if (argvParent === undefined || argvClone === undefined) throw new Error("expected both services");

    expect(argvParent.entrypoint).toEqual(["node", "server.js"]);
    expect(argvClone.entrypoint).toEqual(cloneRequest.command);
    expect(argvClone).not.toHaveProperty("command");

    const stringPlan = await Effect.runPromise(
      planWithClone(
        { name: "clones", services: { web: withEntrypoint } },
        cloneFeature({ ...cloneRequest, command: "echo hello" }),
      ),
    );
    const stringClone = stringPlan.services[ServiceName.make("web-schedule")];
    if (stringClone === undefined) throw new Error("expected the clone");
    expect(stringClone.entrypoint).toEqual(["sh", "-c", "echo hello"]);
    expect(stringClone).not.toHaveProperty("command");
  });

  test("disables the healthcheck when the parent has none", async () => {
    const app = await Effect.runPromise(
      planWithClone(
        { name: "clones", services: { web: { type: "cloned:3.22" } } },
        cloneFeature(cloneRequest),
      ),
    );
    const clone = app.services[ServiceName.make("web-schedule")];
    if (clone === undefined) throw new Error("expected the clone");
    expect(clone.healthcheck).toEqual({
      kind: "none",
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
    });
    expect(clone.readiness).toBeUndefined();
  });

  test("a user override keeps the parent image steps and drops home persistence", async () => {
    const preparedWeb = { type: "cloned-home:3.22", build: { artifact: ["echo artifact"] } };
    const inherit = { ...cloneRequest, name: "web-inherit" };
    const extraStep: ServiceBuildStepIntent = {
      id: "clone.extra",
      phase: "build",
      command: ["echo", "extra"],
    };
    const override = { ...cloneRequest, name: "web-other", user: "www-data", extraBuildSteps: [extraStep] };
    const feature: AppFeatureDefinition = {
      id: "test.clone",
      priority: 500,
      selectors: { names: ["web"] },
      apply: (ctx) =>
        Effect.sync(() => {
          ctx.addClonedService(inherit);
          ctx.addClonedService(override);
        }),
    };
    const app = await Effect.runPromise(
      planWithClone({ name: "clones", services: { web: preparedWeb } }, feature, {
        ...TestRuntimeProvider.capabilities,
        artifactBuild: true,
      }),
    );
    const parent = app.services[ServiceName.make("web")];
    const shared = app.services[ServiceName.make("web-inherit")];
    const own = app.services[ServiceName.make("web-other")];
    if (parent === undefined || shared === undefined || own === undefined)
      throw new Error("expected all three services");

    expect(buildSteps(parent)[0]?.id).toBe(DATA_TREE_OWNERSHIP_STEP_ID);
    expect(buildSteps(shared)[0]).toEqual(buildSteps(parent)[0]);
    expect(buildSteps(shared)).toEqual(buildSteps(parent));
    expect(homeStore(shared)).toBe(homeStore(parent));

    const parentImageSteps = buildSteps(parent).filter(
      (step) => step.id !== DATA_TREE_OWNERSHIP_STEP_ID && step.phase !== "app",
    );
    const imageShape = (step: ServiceBuildStepIntent) => ({
      id: step.id,
      phase: step.phase,
      command: step.command,
    });
    expect(buildSteps(own).map(imageShape)).toEqual([
      ...parentImageSteps.map(imageShape),
      imageShape(extraStep),
    ]);
    expect(buildSteps(own).some((step) => step.id === DATA_TREE_OWNERSHIP_STEP_ID)).toBe(false);
    expect(own.home).toEqual({ state: "disabled" });
    expect(homeStore(own)).toBeUndefined();
    const parentHomeStore = homeStore(parent);
    expect(
      volumeStores(own).some((store) => store === parentHomeStore),
      "a user override must not mount the parent home store",
    ).toBe(false);
  });

  test("a clone never re-claims a Compose host publication", async () => {
    const app = await Effect.runPromise(
      planWithClone(
        { name: "clones", services: { web: { type: "cloned:3.22", ports: ["8099:80"] } } },
        cloneFeature(cloneRequest),
      ),
    );
    const parent = app.services[ServiceName.make("web")];
    const clone = app.services[ServiceName.make("web-schedule")];
    if (parent === undefined || clone === undefined) throw new Error("expected both services");

    expect(parent.endpoints).toContainEqual(
      expect.objectContaining({ _tag: "published", publication: { hostPort: 8099 } }),
    );
    expect(clone.endpoints).toEqual([]);
  });

  test.each([
    ["hostname", { hostnames: ["taken"] }],
    ["network alias", { networks: { default: { aliases: ["taken"] } } }],
  ] as const)("rejects a clone name that collides with an authored %s", async (_label, api) => {
    const result = await Effect.runPromiseExit(
      planWithClone(
        { name: "clones", services: { web, api: { type: "cloned:3.22", ...api } } },
        cloneFeature({ ...cloneRequest, name: "Taken" }),
      ),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    const failure = Cause.findErrorOption(result.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isNone(failure)) return;
    expect(failure.value).toBeInstanceOf(LandofileValidationError);
    if (!(failure.value instanceof LandofileValidationError)) return;
    expect(failure.value.cause).toBeInstanceOf(AppFeatureCloneError);
    if (!(failure.value.cause instanceof AppFeatureCloneError)) return;
    expect(failure.value.cause.reason).toBe("name-collision");
    expect(failure.value.cause.service).toBe("Taken");
    expect(failure.value.cause.from).toBe("web");
    expect(failure.value.message).toContain("taken");
    expect(failure.value.remediation).toContain("taken");
  });

  test("clones carry no log sources and keep their own extra build steps last", async () => {
    const extraStep: ServiceBuildStepIntent = {
      id: "clone.extra",
      phase: "build",
      command: ["echo", "extra"],
    };
    const app = await Effect.runPromise(
      planWithClone(
        {
          name: "clones",
          services: { web: { type: "cloned-logs:3.22", build: { artifact: ["echo artifact"] } } },
        },
        cloneFeature({ ...cloneRequest, user: "node", extraBuildSteps: [extraStep] }),
        { ...TestRuntimeProvider.capabilities, artifactBuild: true },
      ),
    );
    const parent = app.services[ServiceName.make("web")];
    const clone = app.services[ServiceName.make("web-schedule")];
    if (parent === undefined || clone === undefined) throw new Error("expected both services");

    expect(parent.logSources?.map((source) => String(source.id))).toEqual(["access"]);
    expect(buildSteps(parent).some((step) => (step.id ?? "").startsWith("lando-log-redirect"))).toBe(true);

    expect(clone.logSources).toBeUndefined();
    expect(clone.extensions).not.toHaveProperty(LOG_SOURCES_EXTENSION_KEY);
    const inheritedIds = buildSteps(parent)
      .filter(
        (step) =>
          step.id !== DATA_TREE_OWNERSHIP_STEP_ID && !(step.id ?? "").startsWith("lando-log-redirect"),
      )
      .map((step) => step.id);
    expect(buildSteps(clone).map((step) => step.id)).toEqual([...inheritedIds, extraStep.id]);
  });

  test("rejects a clone whose derived internal name is already claimed", async () => {
    const derived = "web-schedule.clones.internal";
    const result = await Effect.runPromiseExit(
      planWithClone(
        {
          name: "clones",
          services: {
            web,
            api: { type: "cloned:3.22", hostnames: [derived] },
          },
        },
        cloneFeature(cloneRequest),
      ),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    const failure = Cause.findErrorOption(result.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isNone(failure)) return;
    expect(failure.value).toBeInstanceOf(LandofileValidationError);
    if (!(failure.value instanceof LandofileValidationError)) return;
    expect(failure.value.cause).toBeInstanceOf(AppFeatureCloneError);
    if (!(failure.value.cause instanceof AppFeatureCloneError)) return;
    expect(failure.value.cause.reason).toBe("name-collision");
    expect(failure.value.cause.service).toBe("web-schedule");
    expect(failure.value.cause.from).toBe("web");
    expect(failure.value.cause.message).toContain(derived);
    expect(failure.value.cause.remediation).toContain(derived);
  });
});
