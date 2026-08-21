import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Schema } from "effect";

import { ConfigService } from "@lando/sdk/services";

import {
  AppsListResultSchema,
  appliedPlansDirectory,
  listServices,
  renderAppsListResult,
} from "../../src/cli/commands/list.ts";
import { writeCwdAppMapEntry } from "../../src/testing/engine-layers.ts";

let userDataRoot: string;
let isolatedCacheRoot: string;

const noDiscover = async () => [];

const fakeConfigService = (dataRoot: string) =>
  Layer.succeed(ConfigService, {
    get: <K extends string>(key: K) =>
      Effect.succeed(key === "userDataRoot" ? (dataRoot as never) : (undefined as never)),
    getEffective: () => Effect.succeed({} as never),
  } as never);

const makeAppliedPlanEnvelope = (id: string, name: string, root: string, services: string[]) => ({
  version: 1,
  data: {
    id,
    name,
    slug: id,
    root,
    provider: "lando",
    services: Object.fromEntries(
      services.map((s) => [s, { name: s, type: "lando.app", primary: false, env: {} }]),
    ),
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata: { source: "apps-list.scenario.test", runtime: 4 },
    extensions: {},
  },
});

const writeAppliedPlan = async (
  dataRoot: string,
  id: string,
  name: string,
  root: string,
  services: string[],
): Promise<void> => {
  const dir = appliedPlansDirectory(dataRoot);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${id}.json`),
    `${JSON.stringify(makeAppliedPlanEnvelope(id, name, root, services), null, 2)}\n`,
  );
};

beforeAll(async () => {
  userDataRoot = await mkdtemp(join(tmpdir(), "lando-apps-list-"));
  isolatedCacheRoot = await mkdtemp(join(tmpdir(), "lando-apps-list-isolated-cache-"));
  await writeAppliedPlan(userDataRoot, "alpha", "alpha", "/srv/alpha", ["appserver"]);
  await writeAppliedPlan(userDataRoot, "bravo", "bravo", "/srv/bravo", ["db", "web"]);
  await writeAppliedPlan(userDataRoot, "global", "global", join(userDataRoot, "global"), [
    "traefik",
    "mailpit",
  ]);
});

afterAll(async () => {
  if (userDataRoot !== undefined) await rm(userDataRoot, { recursive: true, force: true });
  if (isolatedCacheRoot !== undefined) await rm(isolatedCacheRoot, { recursive: true, force: true });
});

describe("apps:list command", () => {
  test("returns an empty list when no provider state exists", async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), "lando-apps-list-empty-"));
    try {
      const result = await Effect.runPromise(
        listServices({
          userDataRoot: emptyRoot,
          userCacheRoot: isolatedCacheRoot,
          discoverContainers: noDiscover,
        }).pipe(Effect.provide(fakeConfigService(emptyRoot))),
      );
      expect(result.apps).toEqual([]);
      expect(renderAppsListResult(result)).toContain("No Lando apps applied");
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  test("discovers applied apps from the provider-lando applied-plans plugin state", async () => {
    const result = await Effect.runPromise(
      listServices({ userDataRoot, userCacheRoot: isolatedCacheRoot, discoverContainers: noDiscover }).pipe(
        Effect.provide(fakeConfigService(userDataRoot)),
      ),
    );
    const names = result.apps.map((a) => a.appName);
    expect(names).toContain("alpha");
    expect(names).toContain("bravo");
    expect(names).toContain("global");
    const bravo = result.apps.find((a) => a.appName === "bravo");
    expect(bravo?.services).toEqual(["db", "web"]);
    expect(bravo?.providerId).toBe("lando");
    expect(bravo?.appRoot).toBe("/srv/bravo");
    const global = result.apps.find((a) => a.appId === "global");
    expect(global?.services).toEqual(["mailpit", "traefik"]);
    expect(global?.appRoot).toBe(join(userDataRoot, "global"));
  });

  test("reads plugin applied-plans and leftover providers/*/apps state", async () => {
    const isolated = await mkdtemp(join(tmpdir(), "lando-apps-list-real-path-"));
    try {
      await writeAppliedPlan(isolated, "cms", "cms", "/srv/cms", ["appserver", "database"]);
      const legacyDir = join(isolated, "providers", "provider-lando", "apps");
      await mkdir(legacyDir, { recursive: true });
      await writeFile(
        join(legacyDir, "legacy-only.json"),
        JSON.stringify({
          version: 1,
          plan: { id: "legacy-only", name: "legacy-only", root: "/srv/legacy", services: { web: {} } },
        }),
      );
      const result = await Effect.runPromise(
        listServices({
          userDataRoot: isolated,
          userCacheRoot: isolatedCacheRoot,
          discoverContainers: noDiscover,
        }).pipe(Effect.provide(fakeConfigService(isolated))),
      );
      expect(result.apps.map((app) => app.appId).sort()).toEqual(["cms", "legacy-only"]);
      expect(result.apps.find((app) => app.appId === "cms")?.appRoot).toBe("/srv/cms");
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });

  test("encodes a JSON payload with the command result schema", async () => {
    const result = await Effect.runPromise(
      listServices({ userDataRoot, userCacheRoot: isolatedCacheRoot, discoverContainers: noDiscover }).pipe(
        Effect.provide(fakeConfigService(userDataRoot)),
      ),
    );
    const encoded = Schema.encodeSync(AppsListResultSchema)(result);
    expect(encoded.apps.length).toBe(3);
    expect(encoded).toEqual(result);
  });

  test("falls back to the resolved user cache root via LANDO_USER_CACHE_ROOT", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-apps-list-default-cache-"));
    await Effect.runPromise(
      writeCwdAppMapEntry({
        cacheRoot,
        entry: {
          cwd: "/srv/default-cache/web",
          appRoot: "/srv/default-cache",
          primaryLandofilePath: "/srv/default-cache/.lando.yml",
          mtimeNs: 1,
          sizeBytes: 2,
          lastUsedAt: 3,
        },
      }),
    );
    const previous = process.env.LANDO_USER_CACHE_ROOT;
    process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
    try {
      const result = await Effect.runPromise(
        listServices({ userDataRoot, discoverContainers: noDiscover }).pipe(
          Effect.provide(fakeConfigService(userDataRoot)),
        ),
      );
      const cached = result.apps.find((app) => app.appRoot === "/srv/default-cache");
      expect(cached?.providerId).toBe("cache");
    } finally {
      // biome-ignore lint/performance/noDelete: delete is required to avoid exposing the string "undefined"
      if (previous === undefined) delete process.env.LANDO_USER_CACHE_ROOT;
      else process.env.LANDO_USER_CACHE_ROOT = previous;
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  test("includes apps discovered from the persistent cwd-app-map cache", async () => {
    const userCacheRoot = await mkdtemp(join(tmpdir(), "lando-apps-list-cache-"));
    await Effect.runPromise(
      writeCwdAppMapEntry({
        cacheRoot: userCacheRoot,
        entry: {
          cwd: "/srv/cached/web",
          appRoot: "/srv/cached",
          primaryLandofilePath: "/srv/cached/.lando.yml",
          mtimeNs: 1,
          sizeBytes: 2,
          lastUsedAt: 3,
        },
      }),
    );

    try {
      const result = await Effect.runPromise(
        listServices({ userDataRoot, userCacheRoot, discoverContainers: noDiscover }).pipe(
          Effect.provide(fakeConfigService(userDataRoot)),
        ),
      );
      const cached = result.apps.find((app) => app.appRoot === "/srv/cached");
      expect(cached).toMatchObject({ appName: "cached", providerId: "cache", services: [] });
    } finally {
      await rm(userCacheRoot, { recursive: true, force: true });
    }
  });
});
