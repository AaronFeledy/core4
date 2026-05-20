import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import { ConfigService } from "@lando/sdk/services";

import { writeCwdAppMapEntry } from "../../src/cache/cwd-app-map.ts";
import { listServices, renderAppsListResult } from "../../src/cli/commands/list.ts";

let userDataRoot: string;

const fakeConfigService = (dataRoot: string) =>
  Layer.succeed(ConfigService, {
    get: <K extends string>(key: K) =>
      Effect.succeed(key === "userDataRoot" ? (dataRoot as never) : (undefined as never)),
    getEffective: () => Effect.succeed({} as never),
  } as never);

const makePlan = (id: string, name: string, root: string, services: string[]) => ({
  version: 1,
  providerId: "lando",
  appId: id,
  plan: {
    id,
    name,
    root,
    provider: "lando",
    services: Object.fromEntries(
      services.map((s) => [s, { name: s, type: "lando.app", primary: false, env: {} }]),
    ),
  },
});

beforeAll(async () => {
  userDataRoot = await mkdtemp(join(tmpdir(), "lando-apps-list-"));
  const appsDir = join(userDataRoot, "providers", "provider-lando", "apps");
  await mkdir(appsDir, { recursive: true });
  await writeFile(
    join(appsDir, "alpha.json"),
    JSON.stringify(makePlan("alpha", "alpha", "/srv/alpha", ["appserver"])),
  );
  await writeFile(
    join(appsDir, "bravo.json"),
    JSON.stringify(makePlan("bravo", "bravo", "/srv/bravo", ["db", "web"])),
  );
});

afterAll(async () => {
  if (userDataRoot !== undefined) await rm(userDataRoot, { recursive: true, force: true });
});

describe("apps:list command", () => {
  test("returns an empty list when no provider state exists", async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), "lando-apps-list-empty-"));
    try {
      const result = await Effect.runPromise(
        listServices({ userDataRoot: emptyRoot }).pipe(Effect.provide(fakeConfigService(emptyRoot))),
      );
      expect(result.apps).toEqual([]);
      expect(renderAppsListResult(result)).toContain("No Lando apps applied");
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  test("discovers applied apps from the provider-lando state directory", async () => {
    const result = await Effect.runPromise(
      listServices({ userDataRoot }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    const names = result.apps.map((a) => a.appName);
    expect(names).toContain("alpha");
    expect(names).toContain("bravo");
    const bravo = result.apps.find((a) => a.appName === "bravo");
    expect(bravo?.services).toEqual(["db", "web"]);
    expect(bravo?.providerId).toBe("lando");
    expect(bravo?.appRoot).toBe("/srv/bravo");
  });

  test("renders a JSON payload with --format json", async () => {
    const result = await Effect.runPromise(
      listServices({ userDataRoot }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    const rendered = renderAppsListResult(result, "json");
    const parsed = JSON.parse(rendered);
    expect(parsed.apps.length).toBe(2);
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
        listServices({ userDataRoot, userCacheRoot }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
      );
      const cached = result.apps.find((app) => app.appRoot === "/srv/cached");
      expect(cached).toMatchObject({ appName: "cached", providerId: "cache", services: [] });
    } finally {
      await rm(userCacheRoot, { recursive: true, force: true });
    }
  });
});
