import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { AppId, ServiceName, type TunnelSession } from "@lando/sdk/schema";
import { PathsService } from "@lando/sdk/services";
import * as StateStoreLayer from "@lando/state-store/service";

import * as BunProcessRunner from "../../src/services/process-runner.ts";
import { reconcileTunnelRegistry, recordTunnelSession } from "../../src/tunnel/registry.ts";

const stateStoreLayer = Layer.merge(
  StateStoreLayer.layer.pipe(Layer.provide(BunProcessRunner.layer)),
  Layer.effect(
    PathsService,
    Effect.sync(() => makeLandoPaths()),
  ),
);

const withTempRoots = async <T>(
  run: (roots: { readonly dataRoot: string; readonly cacheRoot: string }) => Promise<T>,
): Promise<T> => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "lando-tunnel-registry-")));
  const dataRoot = join(base, "data");
  const cacheRoot = join(base, "cache");
  await mkdir(dataRoot, { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  const previousData = process.env.LANDO_USER_DATA_ROOT;
  const previousCache = process.env.LANDO_USER_CACHE_ROOT;
  try {
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
    return await run({ dataRoot, cacheRoot });
  } finally {
    if (previousData === undefined) {
      Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    } else {
      process.env.LANDO_USER_DATA_ROOT = previousData;
    }
    if (previousCache === undefined) {
      Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    } else {
      process.env.LANDO_USER_CACHE_ROOT = previousCache;
    }
    await rm(base, { recursive: true, force: true });
  }
};

const sampleSession = (): TunnelSession => ({
  id: "tun_survive_1",
  app: AppId.make("share-app"),
  provider: "test-tunnel",
  target: {
    _tag: "service",
    service: ServiceName.make("web"),
    port: 80,
    protocol: "http",
  },
  status: "ready",
  detached: true,
  startedAt: "2026-01-01T00:00:00.000Z",
});

describe("tunnel registry durable root", () => {
  test("tunnel registry entry survives removal of a distinct user cache root", async () => {
    await withTempRoots(async ({ dataRoot, cacheRoot }) => {
      // Given a recorded tunnel session and disposable noise under the cache root.
      const session = sampleSession();
      await mkdir(join(cacheRoot, "logs"), { recursive: true });
      await writeFile(join(cacheRoot, "logs", "noise.log"), "disposable");
      await Effect.runPromise(recordTunnelSession(session).pipe(Effect.provide(stateStoreLayer)));

      // When the disposable user cache root is removed entirely.
      await rm(cacheRoot, { recursive: true, force: true });

      // Then the registry still returns the live session and the run artifacts remain under data.
      const sessions = await Effect.runPromise(
        reconcileTunnelRegistry(new Set([session.id])).pipe(Effect.provide(stateStoreLayer)),
      );
      expect(sessions.map((entry) => entry.id)).toEqual([session.id]);
      expect(await Bun.file(join(dataRoot, "tunnels", "registry.bin")).exists()).toBe(true);
      expect(await Bun.file(join(makeLandoPaths().tunnelRunDir, `${session.id}.json`)).exists()).toBe(true);
    });
  });
});
