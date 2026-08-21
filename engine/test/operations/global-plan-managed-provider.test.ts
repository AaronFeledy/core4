import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect, Layer } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { AppPlanner, FileSystem, GlobalAppService, RuntimeProviderRegistry } from "@lando/sdk/services";

import { loadGlobalPlan } from "../../src/operations/global-plan.ts";
import { MANAGED_PROVIDER_ID } from "../../src/providers/managed.ts";

describe("loadGlobalPlan managed provider", () => {
  test("plans the global app on the Lando-managed provider even with leftover docker config", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-796-plan-data-"));
    try {
      const globalRoot = join(dataRoot, "global");
      await mkdir(globalRoot, { recursive: true });
      const distPath = join(globalRoot, ".lando.dist.yml");
      await writeFile(distPath, "name: global\nruntime: 4\nservices: {}\n");

      const selected: Array<string | undefined> = [];
      const planned: Array<string | undefined> = [];
      const layer = Layer.mergeAll(
        Layer.succeed(FileSystem, {
          exists: () => Effect.succeed(true),
          readText: () => Effect.succeed("name: global\nruntime: 4\nservices: {}\n"),
          write: () => Effect.void,
          writeAtomic: () => Effect.void,
          mkdir: () => Effect.void,
          remove: () => Effect.void,
          readDir: () => Effect.succeed([]),
          readFile: () => Effect.succeed(new Uint8Array()),
          writeFile: () => Effect.void,
          read: () => {
            throw new Error("unused");
          },
          stat: () => Effect.succeed({ size: 1, mtimeMs: 0, isFile: true, isDirectory: false }),
          lstat: () => Effect.succeed({ size: 1, mtimeMs: 0, isFile: true, isDirectory: false }),
        } as never),
        Layer.succeed(GlobalAppService, {
          id: "global",
          root: Effect.succeed(AbsolutePath.make(globalRoot)),
          ensureRoot: Effect.void,
          paths: Effect.succeed({
            root: AbsolutePath.make(globalRoot),
            distLandofile: AbsolutePath.make(distPath),
            userLandofile: AbsolutePath.make(join(globalRoot, ".lando.yml")),
          }),
          ensureUserLandofile: Effect.succeed({
            path: AbsolutePath.make(join(globalRoot, ".lando.yml")),
            created: false,
          }),
          ensureRunning: () => Effect.succeed([]),
          regenerateDist: () =>
            Effect.succeed({ path: AbsolutePath.make(distPath), status: "unchanged", serviceIds: [] }),
        } as never),
        Layer.succeed(RuntimeProviderRegistry, {
          list: Effect.succeed([ProviderId.make("lando"), ProviderId.make("docker")]),
          capabilities: Effect.succeed({} as never),
          select: (plan) => {
            selected.push(plan === undefined ? undefined : String(plan.provider));
            return Effect.succeed({
              id: "lando",
              capabilities: { sharedCrossAppNetwork: true },
            } as never);
          },
        }),
        Layer.succeed(AppPlanner, {
          plan: (landofile) =>
            Effect.sync(() => {
              planned.push(landofile.provider === undefined ? undefined : String(landofile.provider));
              return {
                id: AppId.make("global"),
                name: "global",
                slug: "global",
                root: AbsolutePath.make(globalRoot),
                provider: landofile.provider ?? ProviderId.make("docker"),
                services: {},
                routes: [],
                networks: [],
                stores: [],
                fileSync: [],
                metadata: {
                  resolvedAt: DateTime.unsafeMake("1970-01-01T00:00:00.000Z"),
                  source: "test",
                  runtime: 4,
                },
                extensions: {},
              } satisfies AppPlan;
            }),
        }),
      );

      const loaded = await Effect.runPromise(loadGlobalPlan().pipe(Effect.provide(layer)));
      expect(loaded.materialized).toBe(true);
      if (loaded.materialized) {
        expect(String(loaded.plan.provider)).toBe("lando");
        expect(String(loaded.landofile.provider)).toBe(String(MANAGED_PROVIDER_ID));
      }
      expect(selected).toEqual(["lando"]);
      expect(planned).toEqual(["lando"]);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
