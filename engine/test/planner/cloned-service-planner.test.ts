import { describe, expect, test } from "bun:test";

import { AppFeatureCloneError, LandofileValidationError } from "@lando/sdk/errors";
import { definePlugin } from "@lando/sdk/plugins";
import { AbsoluteContainerPath, PluginManifest, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type {
  AppFeatureDefinition,
  ClonedServiceRequest,
  ServiceBuildStepIntent,
  ServiceType,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Effect, Option, Predicate, Schema } from "effect";

import { SERVICE_FEATURES_EXTENSION_KEY } from "../../src/planner/extensions.ts";
import * as Registry from "../../src/plugins/registry.ts";
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
  resolve: ({ service }) => Effect.succeed({ base: "l337", normalizedConfig: service, features: [] }),
};

const pluginFor = (feature: AppFeatureDefinition) =>
  definePlugin({
    name: "@test/cloned-service",
    manifest: Schema.decodeUnknownSync(PluginManifest)({
      name: "@test/cloned-service",
      version: "1.0.0",
      api: 4,
      entry: "index.js",
      contributes: { serviceTypes: [clonedServiceType.id], appFeatures: [feature.id] },
    }),
    serviceTypes: new Map([[clonedServiceType.id, clonedServiceType]]),
    serviceFeatures: new Map(),
    appFeatures: new Map([[feature.id, feature]]),
  });

const planWithClone = (document: Record<string, unknown>, feature: AppFeatureDefinition) =>
  Effect.gen(function* () {
    const landofile = yield* compileTestLandofile(document, "/srv/clones");
    return yield* planApp(
      { landofile, providerCapabilities: TestRuntimeProvider.capabilities },
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
    // Given an app whose web service carries every listener and store kind.
    const app = await Effect.runPromise(
      planWithClone({ name: "clones", services: { web } }, cloneFeature(cloneRequest)),
    );
    const parent = app.services[ServiceName.make("web")];
    const clone = app.services[ServiceName.make("web-schedule")];
    if (parent === undefined || clone === undefined) throw new Error("expected both services");
    const stores = volumeStores(parent);

    // Then the clone mounts exactly the parent's volume stores.
    expect(stores.length).toBeGreaterThan(0);
    expect(volumeStores(clone)).toEqual(stores);
    expect(stores.some((store) => store.includes("--web--shadow--"))).toBe(true);
    expect(stores.some((store) => store.includes("--web--storage--"))).toBe(true);
    expect(homeStore(clone)).toBe(homeStore(parent));

    // And the parent's app build stays with the parent.
    expect(buildSteps(parent).map((step) => step.phase)).toEqual(["build", "app"]);
    expect(buildSteps(clone).map((step) => step.phase)).toEqual(["build"]);

    // And neither the host publication nor the authored route is claimed twice.
    expect(parent.endpoints).toContainEqual(
      expect.objectContaining({ _tag: "published", publication: { hostPort: 8099 } }),
    );
    expect(clone.endpoints).toEqual([]);
    expect(clone.routes).toEqual([]);
    expect(app.routes.map((route) => String(route.service))).toEqual(["web"]);
    expect(app.routes.some((route) => route.hostname === "app.lndo.site")).toBe(true);

    // And the clone answers to no DNS name but its own.
    expect(app.networking?.perAppBridge?.aliases?.[ServiceName.make("web")]).toEqual(["db-alias"]);
    expect(app.networking?.perAppBridge?.aliases?.[ServiceName.make("web-schedule")]).toBeUndefined();
    expect(app.networking?.sharedNetworkMembership?.aliases[ServiceName.make("web-schedule")]).toEqual([
      "web-schedule.clones.internal",
    ]);

    // And it carries no probe or certificate of its own.
    expect(clone.healthcheck).toBeUndefined();
    expect(clone.certs).toBeUndefined();
  });

  test("pins inherited steps and takes its own home when a request overrides user", async () => {
    // Given a clone that runs natively as root instead of the parent's node.
    const app = await Effect.runPromise(
      planWithClone({ name: "clones", services: { web } }, cloneFeature({ ...cloneRequest, user: "root" })),
    );
    const parent = app.services[ServiceName.make("web")];
    const clone = app.services[ServiceName.make("web-schedule")];
    if (parent === undefined || clone === undefined) throw new Error("expected both services");

    // Then the parent's unpinned artifact step is pinned to the parent's build identity.
    expect(buildSteps(parent)[0]?.user).toBeUndefined();
    expect(buildSteps(clone)).toEqual([expect.objectContaining({ phase: "build", user: "root" })]);

    // And the two principals keep separate home stores while sharing the rest.
    expect(homeStore(parent)).toBeDefined();
    expect(homeStore(clone)).toBeDefined();
    expect(homeStore(clone)).not.toBe(homeStore(parent));
    expect(volumeStores(clone)).not.toEqual(volumeStores(parent));
  });

  test("a clone never re-claims a Compose host publication", async () => {
    // Given a parent that publishes a fixed host port through Compose ports.
    const app = await Effect.runPromise(
      planWithClone(
        { name: "clones", services: { web: { type: "cloned:3.22", ports: ["8099:80"] } } },
        cloneFeature(cloneRequest),
      ),
    );
    const parent = app.services[ServiceName.make("web")];
    const clone = app.services[ServiceName.make("web-schedule")];
    if (parent === undefined || clone === undefined) throw new Error("expected both services");

    // Then only the parent owns the publication.
    expect(parent.endpoints).toContainEqual(
      expect.objectContaining({ _tag: "published", publication: { hostPort: 8099 } }),
    );
    expect(clone.endpoints).toEqual([]);
  });

  test.each([
    ["hostname", { hostnames: ["taken"] }],
    ["network alias", { networks: { default: { aliases: ["taken"] } } }],
  ] as const)("rejects a clone name that collides with an authored %s", async (_label, api) => {
    // Given another service that already answers to the clone name.
    const result = await Effect.runPromiseExit(
      planWithClone(
        { name: "clones", services: { web, api: { type: "cloned:3.22", ...api } } },
        cloneFeature({ ...cloneRequest, name: "Taken" }),
      ),
    );

    // Then planning fails at the clone with the colliding name in the remediation.
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
    expect(failure.value.message).toContain("taken");
    expect(failure.value.remediation).toContain("taken");
  });
});
