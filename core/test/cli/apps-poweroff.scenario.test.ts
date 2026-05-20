import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import { ConfigService } from "@lando/sdk/services";

import { writeCwdAppMapEntry } from "../../src/cache/cwd-app-map.ts";
import { poweroff, renderPoweroffResult } from "../../src/cli/commands/poweroff.ts";

let userDataRoot: string;
let userCacheRoot: string;

const fakeConfigService = (dataRoot: string) =>
  Layer.succeed(ConfigService, {
    get: <K extends string>(key: K) =>
      Effect.succeed(key === "userDataRoot" ? (dataRoot as never) : (undefined as never)),
    getEffective: () => Effect.succeed({} as never),
  } as never);

const makePlan = (id: string, name: string, services: string[]) => ({
  version: 1,
  providerId: "lando",
  appId: id,
  plan: {
    id,
    name,
    root: `/srv/${name}`,
    provider: "lando",
    services: Object.fromEntries(
      services.map((s) => [s, { name: s, type: "lando.app", primary: false, env: {} }]),
    ),
  },
});

beforeAll(async () => {
  userDataRoot = await mkdtemp(join(tmpdir(), "lando-apps-poweroff-"));
  userCacheRoot = await mkdtemp(join(tmpdir(), "lando-apps-poweroff-cache-"));
  const appsDir = join(userDataRoot, "providers", "provider-lando", "apps");
  await mkdir(appsDir, { recursive: true });
  await writeFile(join(appsDir, "user.json"), JSON.stringify(makePlan("user-app", "user-app", ["web"])));
  await writeFile(join(appsDir, "global.json"), JSON.stringify(makePlan("global", "global", ["proxy"])));
  await writeFile(join(appsDir, "scratch.json"), JSON.stringify(makePlan("scratch-1", "scratch-1", ["web"])));
  await Effect.runPromise(
    writeCwdAppMapEntry({
      cacheRoot: userCacheRoot,
      entry: {
        cwd: "/srv/cached-only/web",
        appRoot: "/srv/cached-only",
        primaryLandofilePath: "/srv/cached-only/.lando.yml",
        mtimeNs: 1,
        sizeBytes: 2,
        lastUsedAt: 3,
      },
    }),
  );
});

afterAll(async () => {
  if (userDataRoot !== undefined) await rm(userDataRoot, { recursive: true, force: true });
  if (userCacheRoot !== undefined) await rm(userCacheRoot, { recursive: true, force: true });
});

describe("apps:poweroff command", () => {
  test("stops every discovered app by default", async () => {
    const stopped: string[] = [];
    const result = await Effect.runPromise(
      poweroff({
        userDataRoot,
        userCacheRoot,
        stopApp: async (entry) => {
          stopped.push(entry.appId);
        },
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect([...stopped].sort()).toEqual(["global", "scratch-1", "user-app"]);
    expect([...result.appsPoweredOff].sort()).toEqual(["global", "scratch-1", "user-app"]);
    expect(stopped).not.toContain("cached-only");
    expect(result.appsPoweredOff).not.toContain("cached-only");
  });

  test("does not power off cache-only cwd-map entries", async () => {
    const stopped: string[] = [];
    const result = await Effect.runPromise(
      poweroff({
        userDataRoot,
        userCacheRoot,
        stopApp: async (entry) => {
          stopped.push(entry.appId);
        },
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(stopped).not.toContain("cached-only");
    expect(result.appsPoweredOff).not.toContain("cached-only");
  });

  test("respects --keep-global and --keep-scratch", async () => {
    const stopped: string[] = [];
    const result = await Effect.runPromise(
      poweroff({
        userDataRoot,
        userCacheRoot,
        keepGlobal: true,
        keepScratch: true,
        stopApp: async (entry) => {
          stopped.push(entry.appId);
        },
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(stopped).toEqual(["user-app"]);
    expect(result.appsPoweredOff).toEqual(["user-app"]);
    expect(result.keptGlobalApp).toBe(true);
    expect(result.keptScratchApps).toBe(1);
    const rendered = renderPoweroffResult(result);
    expect(rendered).toContain("kept global app running");
    expect(rendered).toContain("kept 1 scratch app running");
  });
});
