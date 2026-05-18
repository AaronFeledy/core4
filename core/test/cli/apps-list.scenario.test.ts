import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import { ConfigService } from "@lando/sdk/services";

import { listServices, renderAppsListResult } from "../../src/cli/commands/list.ts";

let userDataRoot: string;

const fakeConfigService = (dataRoot: string) =>
  Layer.succeed(ConfigService, {
    get: <K extends string>(key: K) =>
      Effect.succeed(key === "userDataRoot" ? (dataRoot as never) : (undefined as never)),
    getEffective: () => Effect.succeed({} as never),
  } as never);

const planJson = (id: string, name: string, root: string, services: string[]) => ({
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
    JSON.stringify(planJson("alpha", "alpha", "/srv/alpha", ["appserver"])),
  );
  await writeFile(
    join(appsDir, "bravo.json"),
    JSON.stringify(planJson("bravo", "bravo", "/srv/bravo", ["db", "web"])),
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
});
