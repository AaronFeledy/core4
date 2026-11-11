import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { StateStoreError } from "@lando/sdk/errors";
import { AppId, ServiceName, type TunnelSession } from "@lando/sdk/schema";
import { PathsService } from "@lando/sdk/services";
import { encodeFrame } from "@lando/state-store/codec";
import * as StateStoreLayer from "@lando/state-store/service";
import { Effect, Layer } from "effect";

import * as BunProcessRunner from "../../src/services/process-runner.ts";
import { reconcileTunnelRegistry, recordTunnelSession } from "../../src/tunnel/registry.ts";
import { TUNNEL_REGISTRY_VERSION, migrateTunnelRegistryEntries } from "../../src/tunnel/registry-migrate.ts";

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

const sampleSession = (overrides: Partial<TunnelSession> = {}): TunnelSession => ({
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
  ...overrides,
});

const routeSession = (id: string, hostname: string, extras: Record<string, unknown> = {}) => ({
  id,
  app: "share-app",
  provider: "test-tunnel",
  target: { _tag: "route", routeId: "https", hostname },
  status: "ready",
  detached: true,
  startedAt: "2026-01-01T00:00:00.000Z",
  ...extras,
});

const writeBinaryRegistry = async (file: string, version: number, payload: unknown): Promise<void> => {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, encodeFrame("binary", version, payload, payload));
};

const readBinaryVersion = async (file: string): Promise<number> => {
  const bytes = await readFile(file);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, false);
};

describe("tunnel registry durable root", () => {
  test.each(["starting", "ready", "stopped", "failed", "unknown"] as const)(
    "reports a live registered session as ready regardless of the start snapshot %s",
    async (status) => {
      await withTempRoots(async () => {
        await Effect.runPromise(
          recordTunnelSession(sampleSession({ status })).pipe(Effect.provide(stateStoreLayer)),
        );

        const sessions = await Effect.runPromise(
          reconcileTunnelRegistry().pipe(Effect.provide(stateStoreLayer)),
        );

        expect(sessions).toEqual([sampleSession({ status: "ready" })]);
      });
    },
  );

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

describe("tunnel registry liveness", () => {
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps a session whose registering process belongs to another user",
    async () => {
      await withTempRoots(async ({ dataRoot }) => {
        // Given: an entry recorded by pid 1, which exists but cannot be signalled by this user (EPERM).
        const registryPath = join(dataRoot, "tunnels", "registry.bin");
        const entries = [{ session: sampleSession({ id: "other-user" }), pid: 1, updatedAt: "2026-01-01" }];
        await writeBinaryRegistry(registryPath, TUNNEL_REGISTRY_VERSION, entries);
        // When
        const sessions = await Effect.runPromise(
          reconcileTunnelRegistry(new Set()).pipe(Effect.provide(stateStoreLayer)),
        );
        // Then: a live process is never reported stale just because it is not ours.
        expect(sessions.map((entry) => entry.id)).toEqual(["other-user"]);
      });
    },
  );
});

describe("tunnel registry version migration", () => {
  test("migrates v2 status snapshots to facts and reports only live sessions", async () => {
    await withTempRoots(async ({ dataRoot }) => {
      const registryPath = join(dataRoot, "tunnels", "registry.bin");
      const entries = [
        { session: sampleSession({ status: "starting" }), pid: process.pid, updatedAt: "2026-01-01" },
        { session: sampleSession({ id: "dead" }), pid: -1, updatedAt: "2026-01-01" },
        {
          session: sampleSession({ id: "provider-live", status: "unknown" }),
          pid: -1,
          updatedAt: "2026-01-01",
        },
      ];
      await writeBinaryRegistry(registryPath, 2, entries);

      const sessions = await Effect.runPromise(
        reconcileTunnelRegistry(new Set(["provider-live"])).pipe(Effect.provide(stateStoreLayer)),
      );

      expect(sessions).toEqual([sampleSession(), sampleSession({ id: "provider-live" })]);
      expect(
        migrateTunnelRegistryEntries(entries, 2).every((entry) => !Object.hasOwn(entry.session, "status")),
      ).toBe(true);
      expect(await readBinaryVersion(registryPath)).toBe(TUNNEL_REGISTRY_VERSION);
    });
  });

  test("migrates a mixed origin/main v1 registry through StateStore without quarantine", async () => {
    await withTempRoots(async ({ dataRoot }) => {
      const validRoute = routeSession("tun_valid_route", "app.lndo.site", {
        publicUrl: "https://public.example.test",
        metadata: { note: "keep-me", count: 3 },
        updatedAt: "2026-02-01T00:00:00.000Z",
      });
      const validWildcard = routeSession("tun_valid_wild", "*.app.lndo.site");
      const validService = {
        id: "tun_valid_service",
        app: "share-app",
        provider: "test-tunnel",
        target: { _tag: "service", service: "web", port: 80, protocol: "http" },
        status: "ready",
        detached: true,
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      const oldHostnamePattern =
        /^(?:\*\.)?(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
      const longWildcard = `*.${[63, 63, 63, 61].map((length) => "a".repeat(length)).join(".")}`;
      expect(oldHostnamePattern.test(longWildcard)).toBe(true);
      const badHostname = routeSession("tun_bad_host", longWildcard);
      const registryPath = join(dataRoot, "tunnels", "registry.bin");
      const legacyEntries = [
        { session: validRoute, pid: process.pid, updatedAt: "2026-01-02T00:00:00.000Z" },
        { session: validWildcard, pid: process.pid, updatedAt: "2026-01-02T01:00:00.000Z" },
        { session: validService, pid: process.pid, updatedAt: "2026-01-03T00:00:00.000Z" },
        { session: badHostname, pid: process.pid, updatedAt: "2026-01-04T00:00:00.000Z" },
      ];
      await writeBinaryRegistry(registryPath, 1, legacyEntries);

      // When reconcile opens the bucket through the real StateStore path.
      const sessions = await Effect.runPromise(
        reconcileTunnelRegistry(
          new Set(["tun_valid_route", "tun_valid_wild", "tun_valid_service", "tun_bad_host"]),
        ).pipe(Effect.provide(stateStoreLayer)),
      );

      // Then valid entries survive with fields intact, the bad host is dropped,
      // the registry file is not quarantined, and the rewrite stamps the current version.
      expect(sessions.map((entry) => entry.id)).toEqual([
        "tun_valid_route",
        "tun_valid_wild",
        "tun_valid_service",
      ]);
      const keptRoute = sessions.find((entry) => entry.id === "tun_valid_route");
      expect(keptRoute).toMatchObject({
        publicUrl: "https://public.example.test",
        metadata: { note: "keep-me", count: 3 },
        updatedAt: "2026-02-01T00:00:00.000Z",
        target: { _tag: "route", routeId: "https", hostname: "app.lndo.site" },
      });
      const siblingNames = await Array.fromAsync(
        new Bun.Glob("registry.bin*").scan({ cwd: join(dataRoot, "tunnels") }),
      );
      expect(siblingNames.filter((name) => name.includes("corrupt"))).toEqual([]);
      expect(await readBinaryVersion(registryPath)).toBe(TUNNEL_REGISTRY_VERSION);
    });
  });

  test("fails closed on unknown frame versions and non-array payloads", () => {
    expect(() => migrateTunnelRegistryEntries([], 99)).toThrow();
    expect(() => migrateTunnelRegistryEntries({ entries: [] }, 1)).toThrow();
  });

  test.each([
    { pid: "invalid" },
    { session: { ...routeSession("malformed", "app.lndo.site"), status: "invalid" } },
    {
      session: {
        ...routeSession("malformed", "app.lndo.site"),
        target: { _tag: "route", routeId: "https", hostname: 7 },
      },
    },
  ])("refuses malformed v1 entries without overwriting the registry: %j", async (fields) => {
    await withTempRoots(async ({ dataRoot }) => {
      const registryPath = join(dataRoot, "tunnels", "registry.bin");
      await writeBinaryRegistry(registryPath, 1, [
        {
          session: routeSession("malformed", "app.lndo.site"),
          pid: process.pid,
          updatedAt: "2026-01-01",
          ...fields,
        },
      ]);
      const before = await Bun.file(registryPath).bytes();

      const result = await Effect.runPromise(
        Effect.result(reconcileTunnelRegistry().pipe(Effect.provide(stateStoreLayer))),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") throw new Error("Malformed registry was accepted");
      expect(result.failure).toMatchObject({ reason: "version" });
      expect(await Bun.file(registryPath).bytes()).toEqual(before);
    });
  });

  test("surfaces StateStore version errors for unknown on-disk frame versions", async () => {
    await withTempRoots(async ({ dataRoot }) => {
      // Given a future/unknown frame version that the migrator rejects.
      const registryPath = join(dataRoot, "tunnels", "registry.bin");
      await writeBinaryRegistry(registryPath, 99, []);

      // When reconcile reads through StateStore.
      const result = await Effect.runPromise(
        Effect.result(reconcileTunnelRegistry().pipe(Effect.provide(stateStoreLayer))),
      );

      // Then the failure is classified as a version error, not silent discard.
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      const error = result.failure;
      expect(error).toBeInstanceOf(StateStoreError);
      expect(error).toMatchObject({ reason: "version", operation: "get" });
    });
  });
});
