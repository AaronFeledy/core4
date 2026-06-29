import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime, Effect, Schema } from "effect";

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
import type { ScratchInfo, ScratchSummary } from "@lando/sdk/services";
import { ScratchAppService } from "@lando/sdk/services";

import {
  ScratchInfoResultSchema,
  ScratchListResultSchema,
  renderScratchInfoResult,
  renderScratchListResult,
} from "../../src/cli/commands/scratch.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { type ScratchRegistryEntry, makeScratchRegistry } from "../../src/scratch-app/registry.ts";

const fixtureDir = join(import.meta.dirname, "fixtures");

const listFixtureInput: ReadonlyArray<ScratchSummary> = [
  {
    id: "scratch-drupal-abc123",
    app: {
      kind: "scratch",
      id: "scratch-drupal-abc123",
      root: AbsolutePath.make("/cache/scratch/scratch-drupal-abc123/root"),
    },
    source: { kind: "fork" },
    mode: "none",
    created: "2026-05-31T18:00:00.000Z",
    status: "attached",
  },
  {
    id: "scratch-empty-def456",
    app: {
      kind: "scratch",
      id: "scratch-empty-def456",
      root: AbsolutePath.make("/cache/scratch/scratch-empty-def456/root"),
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
    root: AbsolutePath.make("/cache/scratch/scratch-drupal-abc123/root"),
  },
  source: { kind: "fork" },
  mode: "none",
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
    expect(table).toContain("scratch-drupal-abc123\tfork\tnone\t2026-05-31T18:00:00.000Z\tattached");
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

const withTempCache = async <T>(run: (cacheRoot: string) => Promise<T>): Promise<T> => {
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-listinfo-")));
  const previous = process.env.LANDO_USER_CACHE_ROOT;
  try {
    process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
    return await run(cacheRoot);
  } finally {
    if (previous === undefined) {
      // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
      delete process.env.LANDO_USER_CACHE_ROOT;
    } else {
      process.env.LANDO_USER_CACHE_ROOT = previous;
    }
    await rm(cacheRoot, { recursive: true, force: true });
  }
};

const scratchRuntime = () => makeLandoRuntime({ bootstrap: "scratch" });

const runScratch = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(scratchRuntime())));

const seedEntry = (cacheRoot: string, overrides: Partial<ScratchRegistryEntry>): ScratchRegistryEntry => {
  const id = overrides.id ?? "scratch-seed-000000";
  return {
    id,
    source: { kind: "fork" },
    isolate: "none",
    detached: false,
    rootPath: join(cacheRoot, "scratch", id, "root"),
    status: "running",
    createdAt: "2026-05-31T18:00:00.000Z",
    updatedAt: "2026-05-31T18:00:00.000Z",
    ...overrides,
  };
};

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-31T18:00:00Z"),
  source: "scratch-list-info.test",
  runtime: 4 as const,
};

const planWithDetails = (cacheRoot: string, id: string): AppPlan => {
  const appserver: ServicePlan = {
    name: ServiceName.make("appserver"),
    type: "php",
    provider: ProviderId.make("lando"),
    primary: true,
    environment: {},
    appMount: {
      source: AbsolutePath.make(join(cacheRoot, "scratch", id, "root")),
      target: PortablePath.make("/app"),
      readOnly: false,
      excludes: [],
      includes: [],
      realization: "passthrough",
    },
    mounts: [
      {
        type: "volume",
        source: "appserver-data",
        target: PortablePath.make("/data"),
        readOnly: false,
        realization: "passthrough",
      },
    ],
    storage: [],
    endpoints: [{ protocol: "http", port: 80, name: "web" }],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: {},
  };
  const database: ServicePlan = {
    name: ServiceName.make("database"),
    type: "mariadb",
    provider: ProviderId.make("lando"),
    primary: false,
    environment: {},
    mounts: [],
    storage: [],
    endpoints: [{ protocol: "tcp", port: 3306 }],
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
    root: AbsolutePath.make(join(cacheRoot, "scratch", id, "root")),
    provider: ProviderId.make("lando"),
    services: { appserver, database } as AppPlan["services"],
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    networking: {
      perAppBridge: { name: `lando-${id}`, driver: "bridge" },
      sharedNetworkMembership: {
        name: "lando_bridge_network",
        aliases: { appserver: [`appserver.${id}.internal`], database: [`database.${id}.internal`] },
      },
    },
    metadata,
    extensions: {},
  };
};

describe("ScratchAppService list/info backed by the registry", () => {
  test("list derives attached / detached / orphan lifetime status", async () => {
    await withTempCache(async (cacheRoot) => {
      const registry = makeScratchRegistry();
      await Effect.runPromise(
        registry.upsert(seedEntry(cacheRoot, { id: "scratch-attached-000001", ownerPid: process.pid })),
      );
      await Effect.runPromise(
        registry.upsert(seedEntry(cacheRoot, { id: "scratch-detached-000002", detached: true })),
      );
      await Effect.runPromise(
        registry.upsert(seedEntry(cacheRoot, { id: "scratch-orphan-000003", ownerPid: 999_999_999 })),
      );

      const listed = await runScratch(Effect.flatMap(ScratchAppService, (service) => service.list()));
      const byId = new Map(listed.map((entry) => [entry.id, entry]));
      expect(byId.get("scratch-attached-000001")?.status).toBe("attached");
      expect(byId.get("scratch-detached-000002")?.status).toBe("detached");
      expect(byId.get("scratch-orphan-000003")?.status).toBe("orphan");
      expect(byId.get("scratch-detached-000002")?.source).toEqual({ kind: "fork" });
      expect(byId.get("scratch-detached-000002")?.mode).toBe("none");
      expect(byId.get("scratch-attached-000001")?.created).toBe("2026-05-31T18:00:00.000Z");
    });
  });

  test("info reads mounts, network membership, and endpoints from the cached plan", async () => {
    await withTempCache(async (cacheRoot) => {
      const id = "scratch-detail-000004";
      await Effect.runPromise(makeScratchRegistry().upsert(seedEntry(cacheRoot, { id })));
      const instanceRoot = join(cacheRoot, "scratch", id);
      await rm(instanceRoot, { recursive: true, force: true }).catch(() => undefined);
      await Bun.write(join(instanceRoot, ".keep"), "");
      const plan = planWithDetails(cacheRoot, id);
      await writeFile(
        join(instanceRoot, "plan.bin"),
        `${JSON.stringify(Schema.encodeSync(AppPlanSchema)(plan))}\n`,
      );

      const info = await runScratch(Effect.flatMap(ScratchAppService, (service) => service.info(id)));
      expect(info.status).toBe("attached");
      expect(info.mounts).toContainEqual({
        service: "appserver",
        target: "/app",
        source: join(cacheRoot, "scratch", id, "root"),
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
    await withTempCache(async (cacheRoot) => {
      const id = "scratch-noplan-000005";
      await Effect.runPromise(makeScratchRegistry().upsert(seedEntry(cacheRoot, { id, detached: true })));
      const info = await runScratch(Effect.flatMap(ScratchAppService, (service) => service.info(id)));
      expect(info.status).toBe("detached");
      expect(info.mounts).toEqual([]);
      expect(info.network).toEqual({});
      expect(info.endpoints).toEqual([]);
    });
  });
});
