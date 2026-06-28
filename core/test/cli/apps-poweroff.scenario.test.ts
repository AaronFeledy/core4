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

  test("stops runtime service once after the app loop", async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(
      poweroff({
        userDataRoot,
        userCacheRoot,
        stopApp: async (entry) => {
          calls.push(`app:${entry.appId}`);
        },
        stopRuntimeService: async (root) => {
          calls.push(`runtime:${root}`);
          return { terminated: true, pid: 1234 };
        },
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(calls.filter((call) => call.startsWith("runtime:"))).toEqual([`runtime:${userDataRoot}`]);
    expect(calls.at(-1)).toBe(`runtime:${userDataRoot}`);
    expect(calls.slice(0, -1).sort()).toEqual(["app:global", "app:scratch-1", "app:user-app"]);
    expect(result.runtimeServiceStopped).toBe(true);
    expect(result.runtimeServicePid).toBe(1234);
  });

  test("result records runtimeServiceStopped=true when seam terminated", async () => {
    const result = await Effect.runPromise(
      poweroff({
        userDataRoot,
        userCacheRoot,
        stopApp: async () => {},
        stopRuntimeService: async () => ({ terminated: true, pid: 1234 }),
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(result.runtimeServiceStopped).toBe(true);
    expect(result.runtimeServicePid).toBe(1234);
  });

  test("result records runtimeServiceStopped=false when seam reports not terminated", async () => {
    const result = await Effect.runPromise(
      poweroff({
        userDataRoot,
        userCacheRoot,
        stopApp: async () => {},
        stopRuntimeService: async () => ({ terminated: false }),
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(result.runtimeServiceStopped).toBe(false);
    expect(result.runtimeServicePid).toBeUndefined();
  });

  test("uses the default runtime service seam when none is injected", async () => {
    const result = await Effect.runPromise(
      poweroff({
        userDataRoot,
        userCacheRoot,
        stopApp: async () => {},
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(result.runtimeServiceStopped).toBe(false);
    expect(result.runtimeServicePid).toBeUndefined();
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

  test("render shows runtime stop line only when runtime stopped", () => {
    const stopped = renderPoweroffResult({
      appsPoweredOff: ["user-app"],
      keptGlobalApp: false,
      keptScratchApps: 0,
      runtimeServiceStopped: true,
      runtimeServicePid: 1234,
    });
    expect(stopped).toContain("Stopped Lando runtime service");

    const notStopped = renderPoweroffResult({
      appsPoweredOff: ["user-app"],
      keptGlobalApp: false,
      keptScratchApps: 0,
      runtimeServiceStopped: false,
    });
    expect(notStopped).not.toContain("Stopped Lando runtime service");
    expect(notStopped).toBe("Powered off: user-app");
  });
});
