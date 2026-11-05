import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { FileSyncSelectionError } from "@lando/sdk/errors";
import { GlobalConfig, LandofileShape, ServiceName, serviceAppMount } from "@lando/sdk/schema";
import { AppPlanner, ConfigService, PathsService, PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Result, Schema } from "effect";
import * as Cache from "../../src/cache/service.ts";
import { normalizeFileSyncBundle } from "../../src/operations/file-sync-bundle.ts";
import {
  type FileSyncCandidateDefinition,
  FileSyncResolver,
  selectFileSyncCandidate,
} from "../../src/plugins/file-sync-resolver.ts";
import * as Registry from "../../src/plugins/registry.ts";
import * as FileSystem from "../../src/services/file-system.ts";
import * as Planner from "../../src/services/planner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

const slow = {
  ...TestRuntimeProvider.capabilities,
  bindMountPerformance: "slow" as const,
  fileSyncTargets: "prepared-volume" as const,
  ephemeralMounts: true,
};
const candidate: FileSyncCandidateDefinition = {
  id: "alternative",
  pluginName: "@test/sync",
  source: "explicit",
  supports: { platform: ["linux", "darwin", "win32"] },
  capabilities: {
    modes: ["two-way-safe"],
    remoteAgentDeployment: "none",
    exclusionPatterns: true,
    conflictReporting: false,
    progressReporting: false,
  },
};

const withPlanner = async (
  run: (input: {
    readonly root: string;
  }) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "lando-sync-policy-"));
  try {
    await run({ root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("plans exact transport filtering while retaining nested includes and tmpfs", async () => {
  await withPlanner(async ({ root }) => {
    await mkdir(join(root, "vendor/subdir"), { recursive: true });
    await writeFile(join(root, "secret.txt"), "private");
    const document = Schema.decodeUnknownSync(LandofileShape)({
      name: "Policy App",
      router: { enabled: false },
      services: {
        web: {
          type: "compose",
          image: "alpine",
          home: false,
          appMount: { target: "/app", excludes: ["secret.txt"], includes: ["vendor/subdir"] },
          mounts: [{ type: "tmpfs", target: "/app/memory" }],
        },
      },
    });
    const resolver = FileSyncResolver.of({
      candidates: [candidate],
      select: (policy) =>
        Result.match(selectFileSyncCandidate([candidate], policy), {
          onFailure: Effect.fail,
          onSuccess: Effect.succeed,
        }),
      acquire: () => Effect.die("Planning must not acquire an engine"),
    });
    const result = await Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) => planner.plan(literalTestLandofile(document, root), slow)).pipe(
        Effect.provide(
          Planner.layer.pipe(
            Layer.provide(
              Layer.mergeAll(Registry.layer, FileSystem.layer, Layer.succeed(FileSyncResolver, resolver)),
            ),
          ),
        ),
      ),
    );
    expect(result.fileSync).toHaveLength(1);
    expect(Result.isSuccess(normalizeFileSyncBundle(result))).toBe(true);
    expect(result.fileSync[0]).toMatchObject({
      engineId: "alternative",
      session: { excludes: expect.arrayContaining(["secret.txt", ".git"]) },
    });
    const mounts = result.services[ServiceName.make("web")]?.mounts;
    expect(mounts).toContainEqual(expect.objectContaining({ type: "volume", target: "/app/vendor" }));
    expect(mounts).toContainEqual(
      expect.objectContaining({ type: "bind", target: "/app/vendor/subdir", realization: "passthrough" }),
    );
    expect(mounts).toContainEqual(expect.objectContaining({ type: "tmpfs", target: "/app/memory" }));
  });
});

test("invalidates cached engine strategy and global passthrough policy", async () => {
  await withPlanner(async ({ root }) => {
    let current = candidate;
    let config = Schema.decodeUnknownSync(GlobalConfig)({});
    let featureCalls = 0;
    const registry = Layer.effect(
      PluginRegistry,
      Effect.gen(function* () {
        const base = yield* PluginRegistry;
        return PluginRegistry.of({
          ...base,
          loadServiceFeature: (id) =>
            base.loadServiceFeature(id).pipe(
              Effect.map((feature) => ({
                ...feature,
                apply: (ctx) =>
                  Effect.suspend(() => {
                    featureCalls += 1;
                    return feature.apply(ctx);
                  }),
              })),
            ),
        });
      }),
    ).pipe(Layer.provide(Registry.layer));
    const resolver = FileSyncResolver.of({
      get candidates() {
        return [current];
      },
      select: (policy) =>
        Result.match(selectFileSyncCandidate([current], policy), {
          onFailure: Effect.fail,
          onSuccess: Effect.succeed,
        }),
      acquire: () => Effect.die("Planning must not acquire an engine"),
    });
    const layer = Planner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          registry,
          Cache.layer,
          FileSystem.layer,
          Layer.succeed(FileSyncResolver, resolver),
          Layer.succeed(
            ConfigService,
            ConfigService.of({
              load: Effect.sync(() => config),
              get: (key) => Effect.sync(() => config[key]),
            }),
          ),
        ),
      ),
    );
    const document = Schema.decodeUnknownSync(LandofileShape)({
      name: "cached-sync-policy",
      router: { enabled: false },
      services: { web: { type: "compose", image: "alpine", home: false } },
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const planner = yield* AppPlanner;
        const plan = () => planner.plan(literalTestLandofile(document, root), slow);
        expect((yield* plan()).fileSync).toHaveLength(1);
        const firstCalls = featureCalls;
        expect((yield* plan()).fileSync).toHaveLength(1);
        expect(featureCalls).toBe(firstCalls);
        current = { ...candidate, capabilities: { ...candidate.capabilities, exclusionPatterns: false } };
        expect((yield* plan()).fileSync).toHaveLength(0);
        expect(featureCalls).toBeGreaterThan(firstCalls);
        config = { ...config, defaultFileSyncEngine: "passthrough" };
        const ordinary = yield* plan();
        expect(ordinary.fileSync).toEqual([]);
        expect(
          serviceAppMount(ordinary.services[ServiceName.make("web")] ?? { mounts: [] })?.realization,
        ).toBe("passthrough");
        const unsupportedBind = yield* Effect.result(
          planner.plan(literalTestLandofile(document, root), {
            ...slow,
            bindMounts: false,
            bindMountPerformance: "none",
          }),
        );
        expect(Result.isFailure(unsupportedBind) && unsupportedBind.failure._tag).toBe("CapabilityError");
        config = { ...config, defaultFileSyncEngine: "alternative" };
        current = { ...candidate, capabilities: { ...candidate.capabilities, modes: ["one-way-safe"] } };
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const failure = yield* Effect.result(plan());
          expect(Result.isFailure(failure) && failure.failure instanceof FileSyncSelectionError).toBe(true);
        }
      }).pipe(Effect.provide(layer)),
    );
  });
});

test("records one engine with separate accelerated, opted-out and absent service policies", async () => {
  await withPlanner(async ({ root }) => {
    const resolver = FileSyncResolver.of({
      candidates: [candidate],
      select: (policy) =>
        Result.match(selectFileSyncCandidate([candidate], policy), {
          onFailure: Effect.fail,
          onSuccess: Effect.succeed,
        }),
      acquire: () => Effect.die("Planning must not acquire engines"),
    });
    const document = Schema.decodeUnknownSync(LandofileShape)({
      name: "mixed-policy",
      router: { enabled: false },
      services: {
        web: {
          type: "compose",
          image: "alpine",
          home: false,
          appMount: { target: "/app", accelerate: false },
        },
        worker: { type: "compose", image: "alpine", home: false },
        database: { type: "compose", image: "alpine", home: false, appMount: false },
      },
    });
    const result = await Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) => planner.plan(literalTestLandofile(document, root), slow)).pipe(
        Effect.provide(
          Planner.layer.pipe(
            Layer.provide(Layer.mergeAll(Registry.layer, Layer.succeed(FileSyncResolver, resolver))),
          ),
        ),
      ),
    );
    expect(result.fileSyncPolicy).toEqual({
      engineId: "alternative",
      reason: "sole-engine",
      services: {
        web: { mode: "ordinary", reason: "service-opt-out" },
        worker: { mode: "accelerated", reason: "sole-engine" },
        database: { mode: "absent", reason: "absent-app-mount" },
      },
    });
    expect(result.fileSync).toHaveLength(1);
    expect(Result.isSuccess(normalizeFileSyncBundle(result))).toBe(true);
  });
});

test.each(["host", "provider"] as const)(
  "an unsupported %s produces explained ordinary plans without acquisition",
  async (unsupportedBy) => {
    await withPlanner(async ({ root }) => {
      const unsupported =
        unsupportedBy === "host" ? { ...candidate, supports: { platform: ["win32" as const] } } : candidate;
      const { fileSyncTargets: _fileSyncTargets, ...withoutPreparedVolumes } = slow;
      const capabilities = unsupportedBy === "host" ? slow : withoutPreparedVolumes;
      const resolver = FileSyncResolver.of({
        candidates: [unsupported],
        select: () => Effect.die("Planner policy must use metadata"),
        acquire: () => Effect.die("Ordinary planning must not acquire engines"),
      });
      const document = Schema.decodeUnknownSync(LandofileShape)({
        name: "ordinary-policy",
        router: { enabled: false },
        services: { web: { type: "compose", image: "alpine", home: false } },
      });
      const result = await Effect.runPromise(
        Effect.flatMap(AppPlanner, (planner) =>
          planner.plan(literalTestLandofile(document, root), capabilities),
        ).pipe(
          Effect.provide(
            Planner.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Registry.layer,
                  Layer.succeed(FileSyncResolver, resolver),
                  Layer.succeed(PathsService, makeLandoPaths({ platform: "linux" })),
                ),
              ),
            ),
          ),
        ),
      );
      expect(result.fileSyncPolicy).toEqual({
        reason: "no-compatible-engine",
        services: { web: { mode: "ordinary", reason: "no-compatible-engine" } },
      });
      expect(result.fileSync).toEqual([]);
    });
  },
);
