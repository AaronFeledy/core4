import { makeLandoPaths } from "@lando/paths";
import { PluginManifestError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PluginManifest,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import {
  PathsService,
  PluginRegistry,
  RouterService,
  type ServiceRuntimeInfo,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService } from "@lando/sdk/test";
import { DateTime, Effect, Layer, Schema } from "effect";
import { globalPolicyBucket } from "../../src/global-app/enablement.ts";
import {
  executeGlobalStopSelection,
  resolveGlobalStopSelection,
  type resolveGlobalTeardown,
} from "../../src/operations/global-teardown.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

export const root = AbsolutePath.make("/tmp/global-stop-selection");
export const id = AppId.make("global");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
  source: "test",
  runtime: 4 as const,
};
const service = (name: string) => ({
  name: ServiceName.make(name),
  type: "lando",
  provider: ProviderId.make("lando"),
  primary: false,
  artifact: { kind: "ref" as const, ref: "test:latest" },
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});
export const plan: AppPlan = {
  id,
  name: "global",
  slug: "global",
  root,
  provider: ProviderId.make("lando"),
  services: {
    [ServiceName.make("mail")]: {
      ...service("mail"),
      dependsOn: [{ service: ServiceName.make("database"), condition: "service_started", required: true }],
    },
    [ServiceName.make("database")]: service("database"),
    [ServiceName.make("sibling")]: service("sibling"),
  },
  routes: ["mail", "database", "sibling"].map((name) => ({
    hostname: `${name}.lndo.site`,
    priority: 1,
    scheme: "http",
    service: ServiceName.make(name),
    endpoint: 80,
    backend: { service: ServiceName.make(name), protocol: "http", port: 80 },
  })),
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};
export type Resolved = Effect.Success<ReturnType<typeof resolveGlobalTeardown>>;

export const harness = (
  options: {
    readonly online?: boolean;
    readonly missing?: boolean;
    readonly race?: boolean;
    readonly observations?: readonly ServiceRuntimeInfo[];
    readonly disabled?: readonly string[];
    readonly inventoryFailure?: boolean;
  } = {},
) => {
  const removed: ServiceRuntimeInfo[] = [];
  const removedIds = new Set<string | undefined>();
  const states = new Map(["mail", "database", "sibling"].map((name) => [name, "running"]));
  const published: string[][] = [];
  const observed = (): readonly ServiceRuntimeInfo[] =>
    (
      options.observations ??
      Array.from(states, ([name, status]) => ({
        app: id,
        appRoot: root,
        providerId: ProviderId.make("lando"),
        service: ServiceName.make(name),
        status,
        publications: { status: "unknown" as const },
        ...(options.missing && name === "mail" ? {} : { containerId: `${name}-container` }),
      }))
    ).filter((observation) => !removedIds.has(observation.containerId));
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    isAvailable: Effect.succeed(options.online ?? true),
    getStatus: Effect.succeed({ running: options.online ?? true }),
    list: () => (options.online === false ? Effect.die("offline list") : Effect.sync(observed)),
    stop: () => Effect.die("selected stop must remove by exact observed identity"),
    removeObservedService: (observation: ServiceRuntimeInfo) =>
      Effect.sync(() => {
        states.delete(String(observation.service));
        removedIds.add(observation.containerId);
        if (options.race) return { kind: "absent" as const };
        removed.push(observation);
        return { kind: "removed" as const };
      }),
    destroy: () => Effect.die("selected stop must preserve volumes, network and applied state"),
    ensureReady: Effect.die("stop must not start runtime"),
  };
  const resolved: Resolved = {
    provider,
    evidence: { kind: "applied", plan },
    materialized: false,
    paths: {
      root,
      distLandofile: AbsolutePath.make(`${root}/.lando.dist.yml`),
      userLandofile: AbsolutePath.make(`${root}/.lando.yml`),
    },
  };
  const router = {
    ...makeTestRouterService(),
    setup: () => Effect.die("stop must not setup router"),
    removeRoutes: () => Effect.die("stop must not delete whole route file"),
    applyRoutes: (routes: AppPlan["routes"]) =>
      Effect.sync(() => {
        published.push(routes.map((route) => String(route.service)));
        return { app: id, appliedRoutes: routes, authorities: [] };
      }),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(
      PathsService,
      makeLandoPaths({
        userDataRoot: "/tmp/global-stop-fixture-state",
        userCacheRoot: "/tmp/global-stop-fixture-cache",
        userConfRoot: "/tmp/global-stop-fixture-conf",
        systemPluginRoot: "/tmp/global-stop-fixture-sys",
        env: {},
        platform: "linux",
      }),
    ),
    Layer.succeed(StateStore, makeTestStateStore().service),
    Layer.succeed(
      PluginRegistry,
      PluginRegistry.of({
        list: options.inventoryFailure
          ? Effect.fail(
              new PluginManifestError({
                message: "Plugin inventory unavailable.",
                issues: [],
                remediation: "Repair plugin inventory.",
              }),
            )
          : Effect.succeed([
              Schema.decodeUnknownSync(PluginManifest)({
                name: "@example/stop",
                version: "1.0.0",
                api: 4,
                contributes: {
                  globalServices: ["database", "sibling"].map((id) => ({
                    id,
                    module: "/missing/global-stop-fixture.ts",
                    enabledByDefault: true,
                  })),
                },
              }),
            ]),
        load: () => Effect.die("unused plugin load"),
        loadServiceType: () => Effect.die("unused service load"),
        loadServiceFeature: () => Effect.die("unused service feature"),
        loadAppFeature: () => Effect.die("unused app feature"),
      }),
    ),
  );
  const run = (names: readonly string[]) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const bucket = yield* globalPolicyBucket();
        yield* bucket.set({
          revision: 1,
          plugins: {
            "@example/stop": {
              contributions: Object.fromEntries(
                (options.disabled ?? []).map((id) => [id, { defaultEnabled: true, enabled: false }]),
              ),
            },
          },
        });
        const selection = yield* resolveGlobalStopSelection(resolved, names);
        return yield* executeGlobalStopSelection(resolved, selection);
      }).pipe(Effect.provideService(RouterService, router), Effect.provide(layer)),
    );
  return { resolved, removed, states, published, run, observed, layer };
};
