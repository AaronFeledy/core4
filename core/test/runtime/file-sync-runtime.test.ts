import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSyncResolver } from "@lando/engine/plugins/file-sync-resolver";
import { definePlugin } from "@lando/sdk/plugins";
import {
  AbsolutePath,
  GlobalConfig,
  LandofileShape,
  LoadScopedLandofile,
  PluginManifest,
} from "@lando/sdk/schema";
import { AppPlanner, ConfigService, FileSyncEngine } from "@lando/sdk/services";
import { TestFileSyncEngine, TestRuntimeProvider } from "@lando/sdk/test";
import { Context, Effect, Layer, Schema } from "effect";
import { type AppRuntimeServices, makeLandoRuntime } from "../../src/runtime/layer.ts";

const appRuntimeProvidesFileSyncEngine: FileSyncEngine extends AppRuntimeServices ? true : false = false;

test("the generated runtime plans and acquires an explicit engine without resurrecting a disabled bundled engine", async () => {
  expect(appRuntimeProvidesFileSyncEngine).toBe(false);
  const root = await mkdtemp(join(tmpdir(), "lando-runtime-sync-policy-"));
  const calls: string[] = [];
  const capabilities = { ...TestFileSyncEngine.capabilities, exclusionPatterns: true };
  const manifest = Schema.decodeUnknownSync(PluginManifest)({
    name: "@test/runtime-sync",
    version: "1.0.0",
    api: 4,
    contributes: {
      fileSyncEngines: [
        { id: "explicit-sync", supports: { platform: ["linux", "darwin", "win32"] }, capabilities },
      ],
    },
  });
  const entry = definePlugin({
    name: manifest.name,
    manifest,
    fileSyncEngines: new Map([
      [
        "explicit-sync",
        {
          make: (ctx) => {
            calls.push(ctx.id);
            return Layer.succeed(FileSyncEngine, {
              ...TestFileSyncEngine,
              id: "explicit-sync",
              capabilities,
            });
          },
        },
      ],
    ]),
  });
  const config = Schema.decodeUnknownSync(GlobalConfig)({ defaultFileSyncEngine: "explicit-sync" });
  const configLayer = Layer.succeed(
    ConfigService,
    ConfigService.of({
      load: Effect.succeed(config),
      get: (key) => Effect.succeed(config[key]),
    }),
  );
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            makeLandoRuntime({
              bootstrap: "app",
              plugins: {
                policy: "bundled-only",
                manifests: [{ manifest, entry }],
                layers: [configLayer],
                disable: ["@lando/file-sync-mutagen"],
              },
            }),
          );
          const resolver = Context.get(context, FileSyncResolver);
          const planner = Context.get(context, AppPlanner);
          expect(resolver.candidates.map(({ id }) => id)).toEqual(["explicit-sync"]);
          const document = Schema.decodeUnknownSync(LandofileShape)({
            name: "runtime-sync-policy",
            router: { enabled: false },
            services: { app: { type: "compose", image: "alpine", home: false } },
          });
          const plan = yield* planner.plan(
            LoadScopedLandofile.make({
              stage: "load-scoped",
              document,
              pendingSites: [],
              context: { appRoot: AbsolutePath.make(root), env: {} },
            }),
            {
              ...TestRuntimeProvider.capabilities,
              bindMountPerformance: "slow",
              fileSyncTargets: "prepared-volume",
            },
          );
          expect(plan.fileSync).toHaveLength(1);
          expect(plan.fileSync[0]).toMatchObject({
            engineId: "explicit-sync",
            session: { excludes: expect.arrayContaining([".git"]) },
          });
          expect(calls).toEqual([]);
          const engine = yield* resolver.acquire(plan.fileSync[0]?.engineId ?? "missing");
          expect(engine.id).toBe("explicit-sync");
          expect(calls).toEqual(["@test/runtime-sync"]);
          const missing = yield* Effect.result(resolver.acquire("mutagen"));
          expect(missing._tag).toBe("Failure");
        }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
