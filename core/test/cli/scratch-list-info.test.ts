import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRATCH_DESIRED_PLAN_VERSION } from "@lando/engine/scratch-app/plan";
import { type ScratchRegistryEntry, makeScratchRegistry } from "@lando/engine/scratch-app/registry";
import { ProxyError } from "@lando/sdk/errors";
import type { RouteEvidence, RoutePlan } from "@lando/sdk/schema";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  AppPlan as AppPlanSchema,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { RouterServiceShape, ScratchInfo, ScratchSummary } from "@lando/sdk/services";
import { RouterService, ScratchAppService } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";
import { makeStateStore } from "@lando/state-store/service";
import { DateTime, Effect, Schema } from "effect";
import {
  ScratchInfoResultSchema,
  ScratchListResultSchema,
  renderScratchInfoResult,
  renderScratchListResult,
} from "../../src/cli/commands/scratch.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { withService } from "../../src/testing/test-runtime.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";
import { withEnvVar } from "../_support/temp-cwd.ts";

const testRegistry = () => makeScratchRegistry(makeStateStore({ privateFileAccess: ownerOnlyFileAccess }));

/** Seeds pass through acquisition, as a real scratch start does, before their recorded status. */
const seedRegistry = (entry: ScratchRegistryEntry) => {
  const registry = testRegistry();
  return registry.upsert("acquire", entry).pipe(Effect.andThen(registry.upsert("mark-running", entry)));
};

const seedScratchPlan = (instanceRoot: string, plan: AppPlan): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = makeStateStore({ privateFileAccess: ownerOnlyFileAccess });
      const bucket = yield* store.open({
        root: { path: AbsolutePath.make(instanceRoot) },
        key: "plan.bin",
        schema: AppPlanSchema,
        version: SCRATCH_DESIRED_PLAN_VERSION,
        codec: "binary",
        mode: 0o600,
        onCorrupt: "quarantine",
        onVersionMismatch: "discard",
      });
      yield* bucket.set(plan);
    }),
  );

const fixtureDir = join(import.meta.dirname, "fixtures");

const listFixtureInput: ReadonlyArray<ScratchSummary> = [
  {
    id: "scratch-drupal-abc123",
    app: {
      kind: "scratch",
      id: "scratch-drupal-abc123",
      root: AbsolutePath.make("/data/scratch/scratch-drupal-abc123/root"),
    },
    source: { kind: "fork" },
    mode: "full",
    created: "2026-05-31T18:00:00.000Z",
    status: "attached",
  },
  {
    id: "scratch-empty-def456",
    app: {
      kind: "scratch",
      id: "scratch-empty-def456",
      root: AbsolutePath.make("/data/scratch/scratch-empty-def456/root"),
    },
    source: { kind: "recipe", ref: "empty" },
    mode: "full",
    created: "2026-05-31T18:05:00.000Z",
    status: "detached",
  },
];

const infoFixtureInput: ScratchInfo = {
  id: "scratch-drupal-abc123",
  app: {
    kind: "scratch",
    id: "scratch-drupal-abc123",
    root: AbsolutePath.make("/data/scratch/scratch-drupal-abc123/root"),
  },
  source: { kind: "fork" },
  mode: "full",
  created: "2026-05-31T18:00:00.000Z",
  status: "attached",
  mounts: [
    { service: "appserver", target: "/app", source: "/home/me/drupal", kind: "app", readOnly: false },
    { service: "appserver", target: "/data", source: "appserver-data", kind: "volume", readOnly: true },
  ],
  network: { perAppBridge: "lando-scratch-drupal-abc123", sharedNetwork: "lando_bridge_network" },
  endpoints: [
    { service: "appserver", endpoints: [{ protocol: "http", port: 80, name: "web" }] },
    { service: "database", endpoints: [{ protocol: "tcp", port: 3306 }] },
  ],
};

describe("scratch list/info JSON renderer snapshots", () => {
  test("list result schema encoding matches the named fixture", async () => {
    const expected = await Bun.file(join(fixtureDir, "scratch-list.json")).json();
    expect(Schema.encodeSync(ScratchListResultSchema)(listFixtureInput)).toEqual(expected);
  });

  test("info result schema encoding matches the named fixture", async () => {
    const expected = await Bun.file(join(fixtureDir, "scratch-info.json")).json();
    expect(Schema.encodeSync(ScratchInfoResultSchema)(infoFixtureInput)).toEqual(expected);
  });

  test("list table renderer surfaces id / source / mode / created / status", () => {
    const table = renderScratchListResult(listFixtureInput, "table");
    expect(table.split("\n")[0]).toBe("ID\tSOURCE\tMODE\tCREATED\tSTATUS");
    expect(table).toContain("scratch-drupal-abc123\tfork\tfull\t2026-05-31T18:00:00.000Z\tattached");
    expect(table).toContain("scratch-empty-def456\trecipe:empty\tfull\t2026-05-31T18:05:00.000Z\tdetached");
  });

  test("info table renderer surfaces mounts, network membership, and endpoints", () => {
    const text = renderScratchInfoResult(infoFixtureInput, "table");
    expect(text).toContain("status: attached");
    expect(text).toContain("network: bridge=lando-scratch-drupal-abc123, shared=lando_bridge_network");
    expect(text).toContain("appserver /app <- /home/me/drupal (app)");
    expect(text).toContain("appserver /data <- appserver-data (volume,ro)");
    expect(text).toContain("appserver http:80 (web)");
    expect(text).toContain("database tcp:3306");
  });
});

const withTempRoots = async <T>(
  run: (roots: { readonly dataRoot: string; readonly cacheRoot: string }) => Promise<T>,
): Promise<T> => {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-listinfo-data-")));
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-listinfo-cache-")));
  try {
    return await withEnvVar("LANDO_USER_DATA_ROOT", dataRoot, () =>
      withEnvVar("LANDO_USER_CACHE_ROOT", cacheRoot, () => run({ dataRoot, cacheRoot })),
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
};

const scratchRuntime = (router?: RouterServiceShape) =>
  makeLandoRuntime({
    bootstrap: "scratch",
    ...(router === undefined
      ? {}
      : { plugins: { policy: "bundled-only", layers: [withService(RouterService, router)] } }),
  });

const runScratch = <A, E>(
  effect: Effect.Effect<A, E, ScratchAppService>,
  router?: RouterServiceShape,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(scratchRuntime(router))));

const seedEntry = (dataRoot: string, overrides: Partial<ScratchRegistryEntry>): ScratchRegistryEntry => {
  const id = overrides.id ?? "scratch-seed-000000";
  return {
    id,
    source: { kind: "fork" },
    isolate: "full",
    detached: false,
    rootPath: join(dataRoot, "scratch", id, "root"),
    layout: "managed",
    status: "running",
    createdAt: "2026-05-31T18:00:00.000Z",
    updatedAt: "2026-05-31T18:00:00.000Z",
    ...overrides,
  };
};

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-31T18:00:00Z"),
  source: "scratch-list-info.test",
  runtime: 4 as const,
};

const planWithDetails = (dataRoot: string, id: string): AppPlan => {
  const appserverName = ServiceName.make("appserver");
  const databaseName = ServiceName.make("database");
  const appserver: ServicePlan = {
    name: appserverName,
    type: "php",
    provider: ProviderId.make("lando"),
    primary: true,
    environment: {},
    mounts: [
      {
        type: "bind",
        source: AbsolutePath.make(join(dataRoot, "scratch", id, "root")),
        target: PortablePath.make("/app"),
        readOnly: false,
        excludes: [],
        includes: [],
        realization: "passthrough",
        role: "app",
      },
      {
        type: "volume",
        store: "appserver-data",
        target: PortablePath.make("/data"),
        readOnly: false,
      },
    ],
    endpoints: [{ kind: "internal", protocol: "http", port: 80, name: "web" }],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: {},
  };
  const database: ServicePlan = {
    name: databaseName,
    type: "mariadb",
    provider: ProviderId.make("lando"),
    primary: false,
    environment: {},
    mounts: [],
    endpoints: [{ kind: "internal", protocol: "tcp", port: 3306 }],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: {},
  };
  return {
    id: AppId.make(id),
    name: id,
    slug: id,
    root: AbsolutePath.make(join(dataRoot, "scratch", id, "root")),
    provider: ProviderId.make("lando"),
    services: { [appserverName]: appserver, [databaseName]: database },
    routes: [],
    stores: [],
    fileSync: [],
    networking: {
      perAppBridge: { name: `lando-${id}`, driver: "bridge" },
      sharedNetworkMembership: {
        name: "lando_bridge_network",
        aliases: {
          [appserverName]: [`appserver.${id}.internal`],
          [databaseName]: [`database.${id}.internal`],
        },
      },
    },
    metadata,
    extensions: {},
  };
};

describe("ScratchAppService list/info backed by the registry", () => {
  test("list derives attached / detached / orphan lifetime status", async () => {
    await withTempRoots(async ({ dataRoot }) => {
      await Effect.runPromise(
        seedRegistry(seedEntry(dataRoot, { id: "scratch-attached-000001", ownerPid: process.pid })),
      );
      await Effect.runPromise(
        seedRegistry(seedEntry(dataRoot, { id: "scratch-detached-000002", detached: true })),
      );
      await Effect.runPromise(
        seedRegistry(seedEntry(dataRoot, { id: "scratch-orphan-000003", ownerPid: 999_999_999 })),
      );

      const listed = await runScratch(Effect.flatMap(ScratchAppService, (service) => service.list()));
      const byId = new Map(listed.map((entry) => [entry.id, entry]));
      expect(byId.get("scratch-attached-000001")?.status).toBe("attached");
      expect(byId.get("scratch-detached-000002")?.status).toBe("detached");
      expect(byId.get("scratch-orphan-000003")?.status).toBe("orphan");
      expect(byId.get("scratch-detached-000002")?.source).toEqual({ kind: "fork" });
      expect(byId.get("scratch-detached-000002")?.mode).toBe("full");
      expect(byId.get("scratch-attached-000001")?.created).toBe("2026-05-31T18:00:00.000Z");
    });
  });

  test("info reads mounts, network membership, and endpoints from the cached plan", async () => {
    await withTempRoots(async ({ dataRoot }) => {
      const id = "scratch-detail-000004";
      await Effect.runPromise(seedRegistry(seedEntry(dataRoot, { id })));
      const instanceRoot = join(dataRoot, "scratch", id);
      await rm(instanceRoot, { recursive: true, force: true }).catch(() => undefined);
      await Bun.write(join(instanceRoot, ".keep"), "");
      const plan = planWithDetails(dataRoot, id);
      await seedScratchPlan(instanceRoot, plan);

      const info = await runScratch(Effect.flatMap(ScratchAppService, (service) => service.info(id)));
      expect(info.status).toBe("attached");
      expect(info.mounts).toContainEqual({
        service: "appserver",
        target: "/app",
        source: join(dataRoot, "scratch", id, "root"),
        kind: "app",
        readOnly: false,
      });
      expect(info.mounts).toContainEqual({
        service: "appserver",
        target: "/data",
        source: "appserver-data",
        kind: "volume",
        readOnly: false,
      });
      expect(info.network).toEqual({
        perAppBridge: `lando-${id}`,
        sharedNetwork: "lando_bridge_network",
      });
      expect(info.endpoints).toContainEqual({
        service: "appserver",
        endpoints: [{ protocol: "http", port: 80, name: "web" }],
      });
      expect(info.endpoints).toContainEqual({
        service: "database",
        endpoints: [{ protocol: "tcp", port: 3306 }],
      });
    });
  });

  test("info degrades gracefully to empty detail when no plan is cached", async () => {
    await withTempRoots(async ({ dataRoot }) => {
      const id = "scratch-noplan-000005";
      await Effect.runPromise(seedRegistry(seedEntry(dataRoot, { id, detached: true })));
      const info = await runScratch(Effect.flatMap(ScratchAppService, (service) => service.info(id)));
      expect(info.status).toBe("detached");
      expect(info.mounts).toEqual([]);
      expect(info.network).toEqual({});
      expect(info.endpoints).toEqual([]);
    });
  });

  const route = (service: string, hostname: string): RoutePlan => ({
    priority: 2,
    hostname,
    scheme: "http",
    service: ServiceName.make(service),
    backend: { service: ServiceName.make(service), protocol: "http", port: 80 },
  });
  const routes = [
    { ...route("appserver", "appserver.scratch-routes-000006.lndo.site"), pathPrefix: "/hello" },
    route("database", "admin.scratch-routes-000006.lndo.site"),
    route("appserver", "*.scratch-routes-000006.lndo.site"),
  ];
  const observing = (observeRoutes: RouterServiceShape["observeRoutes"]): RouterServiceShape => ({
    ...makeTestRouterService(),
    id: "test",
    observeRoutes,
  });
  const confirmed =
    (only: ReadonlyArray<RoutePlan>): RouterServiceShape["observeRoutes"] =>
    () =>
      Effect.succeed({
        configuredAuthorities: [],
        observation: {
          status: "present",
          publications: only.map((entry) => ({
            route: entry,
            authority: { scheme: "http", hostname: entry.hostname, port: 38080 },
          })),
        },
      } satisfies RouteEvidence);

  interface InfoRoutesCase {
    readonly router: RouterServiceShape;
    readonly plan?: Partial<Pick<AppPlan, "router" | "routes">>;
    readonly expected: typeof ScratchInfoResultSchema.Encoded.routes;
    readonly routeLines?: readonly string[];
  }
  const appserverRoute = {
    service: "appserver",
    host: "appserver.scratch-routes-000006.lndo.site",
    protocol: "http",
    port: 38080,
    pathPrefix: "/hello",
    hostMatch: "exact",
    url: "http://appserver.scratch-routes-000006.lndo.site:38080/hello",
  } as const;
  const infoRoutesCases: ReadonlyArray<readonly [string, InfoRoutesCase]> = [
    [
      "every route the router confirms",
      {
        router: observing(confirmed(routes)),
        expected: [
          appserverRoute,
          {
            service: "database",
            host: "admin.scratch-routes-000006.lndo.site",
            protocol: "http",
            port: 38080,
            pathPrefix: "",
            hostMatch: "exact",
            url: "http://admin.scratch-routes-000006.lndo.site:38080",
          },
          {
            service: "appserver",
            host: "*.scratch-routes-000006.lndo.site",
            protocol: "http",
            port: 38080,
            pathPrefix: "",
            hostMatch: "pattern",
          },
        ],
        routeLines: [
          "routes:",
          "  appserver http://appserver.scratch-routes-000006.lndo.site:38080/hello",
          "  database http://admin.scratch-routes-000006.lndo.site:38080",
          "  appserver *.scratch-routes-000006.lndo.site:38080 [http pattern]",
        ],
      },
    ],
    [
      "only the routes the router confirms",
      {
        router: observing(confirmed(routes.slice(0, 1))),
        expected: [appserverRoute],
      },
    ],
    [
      "no routes when the router cannot confirm them",
      {
        router: observing(() =>
          Effect.succeed({ configuredAuthorities: [], observation: { status: "unknown" } }),
        ),
        expected: [],
      },
    ],
    [
      "no routes when observation fails",
      {
        router: observing(() =>
          Effect.fail(new ProxyError({ proxyId: "test", message: "down", remediation: "Start the router." })),
        ),
        expected: [],
      },
    ],
    [
      "no routes field when routing is disabled",
      { router: observing(confirmed(routes)), plan: { router: { enabled: false } }, expected: undefined },
    ],
    [
      "no routes field when the scratch declares no routes",
      { router: observing(confirmed(routes)), plan: { routes: [] }, expected: undefined },
    ],
  ];

  test.each(infoRoutesCases)(
    "info reports %s",
    async (_label, { router, plan: overrides, expected, routeLines }) => {
      await withTempRoots(async ({ dataRoot }) => {
        const id = "scratch-routes-000006";
        await Effect.runPromise(seedRegistry(seedEntry(dataRoot, { id })));
        const instanceRoot = join(dataRoot, "scratch", id);
        await Bun.write(join(instanceRoot, ".keep"), "");
        await seedScratchPlan(instanceRoot, { ...planWithDetails(dataRoot, id), routes, ...overrides });

        const info = await runScratch(
          Effect.flatMap(ScratchAppService, (service) => service.info(id)),
          router,
        );
        expect(Schema.encodeSync(ScratchInfoResultSchema)(info).routes).toStrictEqual(expected);
        if (routeLines !== undefined)
          expect(renderScratchInfoResult(info).split("\n").slice(-routeLines.length)).toEqual([
            ...routeLines,
          ]);
      });
    },
  );
});
