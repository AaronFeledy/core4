import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, Result, Schema, Stream } from "effect";

import { makeTestManagedFileStore } from "@lando/managed-file/testing";
import { makeLandoPaths } from "@lando/paths";
import { FileSyncSelectionError } from "@lando/sdk/errors";
import type { LandoPluginContext, LandoPluginModule } from "@lando/sdk/plugins";
import {
  AppPlan,
  type FileSyncEngineCapabilities,
  type FileSyncEngineDescriptor,
  PluginManifest,
} from "@lando/sdk/schema";
import {
  Downloader,
  FileSyncEngine,
  type FileSyncEngineShape,
  ManagedFileService,
  PathsService,
  ProcessRunner,
  StateStore,
} from "@lando/sdk/services";
import { TestFileSyncEngine } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { makeTestStateStore } from "@lando/state-store/testing";
import * as HttpClient from "effect/http/HttpClient";

import { resolveFileSyncMountPlan } from "../../src/operations/file-sync-plan.ts";
import { PluginContributionGraph } from "../../src/plugins/contribution-graph.ts";
import {
  type FileSyncCandidateDefinition,
  FileSyncResolver,
  selectFileSyncCandidate,
} from "../../src/plugins/file-sync-resolver.ts";
import { loadInstalledPluginManifest } from "../../src/plugins/installed-plugin-loader.ts";
import { makeTestDownloader } from "../../src/testing/downloader.ts";
import { acceleratedPlan } from "../operations/accelerated-start-recovery-support.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";
import { stubHttpClient } from "./stub-http-client.ts";

const baseCapabilities = (
  overrides: Partial<FileSyncEngineCapabilities> = {},
): FileSyncEngineCapabilities => ({
  modes: ["two-way-safe"],
  remoteAgentDeployment: "none",
  exclusionPatterns: true,
  conflictReporting: false,
  progressReporting: false,
  ...overrides,
});

const candidate = (
  id: string,
  options: {
    readonly source?: string;
    readonly pluginName?: string;
    readonly capabilities?: FileSyncEngineCapabilities;
    readonly defaultFor?: FileSyncEngineDescriptor["defaultFor"];
  } = {},
): FileSyncCandidateDefinition => ({
  id,
  pluginName: options.pluginName ?? `@example/${id}`,
  source: options.source ?? "bundled",
  capabilities: options.capabilities ?? baseCapabilities(),
  supports: { platform: ["linux", "darwin", "win32"] },
  ...(options.defaultFor === undefined ? {} : { defaultFor: options.defaultFor }),
});

describe("selectFileSyncCandidate", () => {
  test("returns undefined for native bind performance without inspecting engines", () => {
    const result = selectFileSyncCandidate([candidate("alpha"), candidate("beta")], {
      platform: "linux",
      bindMountPerformance: "native",
    });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success).toBeUndefined();
  });

  test("returns undefined for reserved passthrough policy", () => {
    const result = selectFileSyncCandidate([candidate("alpha")], {
      platform: "linux",
      bindMountPerformance: "slow",
      fileSyncTargets: "prepared-volume",
      defaultEngine: "passthrough",
    });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success).toBeUndefined();
  });

  test("selects configured alternative over matching default", () => {
    const configured = candidate("alt", { source: "user" });
    const bundledDefault = candidate("mutagen", {
      defaultFor: { platform: ["linux", "darwin", "win32"], bindMountPerformance: ["slow"] },
    });
    const result = selectFileSyncCandidate([bundledDefault, configured], {
      platform: "linux",
      bindMountPerformance: "slow",
      fileSyncTargets: "prepared-volume",
      defaultEngine: "alt",
    });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success).toBe(configured);
  });

  test("selects the unique matching default regardless of discovery order", () => {
    const other = candidate("other");
    const selected = candidate("default", {
      defaultFor: { bindMountPerformance: ["slow"] },
    });
    for (const order of [
      [other, selected],
      [selected, other],
    ] as const) {
      const result = selectFileSyncCandidate(order, {
        platform: "darwin",
        bindMountPerformance: "slow",
        fileSyncTargets: "prepared-volume",
      });
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) expect(result.success?.id).toBe("default");
    }
  });

  test("matches defaultFor dimensions with AND across keys and OR within a key", () => {
    const both = candidate("both", {
      defaultFor: { platform: ["win32"], bindMountPerformance: ["slow"] },
    });
    const platformOnly = candidate("platform-only", {
      defaultFor: { platform: ["linux"] },
    });
    const winSlow = selectFileSyncCandidate([both, platformOnly], {
      platform: "win32",
      bindMountPerformance: "slow",
      fileSyncTargets: "prepared-volume",
    });
    expect(Result.isSuccess(winSlow)).toBe(true);
    if (Result.isSuccess(winSlow)) expect(winSlow.success?.id).toBe("both");

    const linuxSlow = selectFileSyncCandidate([both, platformOnly], {
      platform: "linux",
      bindMountPerformance: "slow",
      fileSyncTargets: "prepared-volume",
    });
    expect(Result.isSuccess(linuxSlow)).toBe(true);
    if (Result.isSuccess(linuxSlow)) expect(linuxSlow.success?.id).toBe("platform-only");
  });

  test("empty defaultFor does not nominate a default", () => {
    const empty = candidate("empty", { defaultFor: {} });
    const other = candidate("other");
    const result = selectFileSyncCandidate([empty, other], {
      platform: "linux",
      bindMountPerformance: "slow",
      fileSyncTargets: "prepared-volume",
    });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.reason).toBe("ambiguous");
  });

  test("selects the sole installed engine when no default matches", () => {
    const only = candidate("only");
    const result = selectFileSyncCandidate([only], {
      platform: "linux",
      bindMountPerformance: "slow",
      fileSyncTargets: "prepared-volume",
    });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success).toBe(only);
  });

  test("fails unknown configured engine id", () => {
    const result = selectFileSyncCandidate([candidate("alpha")], {
      platform: "linux",
      bindMountPerformance: "slow",
      fileSyncTargets: "prepared-volume",
      defaultEngine: "missing",
    });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(FileSyncSelectionError);
      expect(result.failure.reason).toBe("unknown");
      expect(result.failure.engineId).toBe("missing");
    }
  });

  test("uses ordinary binds when no engine is installed for slow binds", () => {
    const result = selectFileSyncCandidate([], {
      platform: "linux",
      bindMountPerformance: "slow",
      fileSyncTargets: "prepared-volume",
    });
    expect(Result.isSuccess(result) && result.success).toBeUndefined();
  });

  test("fails duplicate ids deterministically regardless of order", () => {
    const first = candidate("dup", { source: "bundled", pluginName: "@a/one" });
    const second = candidate("dup", { source: "user", pluginName: "@b/two" });
    for (const order of [
      [first, second],
      [second, first],
    ] as const) {
      const result = selectFileSyncCandidate(order, {
        platform: "linux",
        bindMountPerformance: "slow",
        fileSyncTargets: "prepared-volume",
      });
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.reason).toBe("duplicate");
        expect(result.failure.engineId).toBe("dup");
        expect(result.failure.candidates).toEqual(["dup", "dup"]);
      }
    }
  });

  test("fails ambiguous matching defaults with sorted candidate ids", () => {
    const result = selectFileSyncCandidate(
      [
        candidate("b", { defaultFor: { bindMountPerformance: ["slow"] } }),
        candidate("a", { defaultFor: { bindMountPerformance: ["slow"] } }),
      ],
      { platform: "linux", bindMountPerformance: "slow", fileSyncTargets: "prepared-volume" },
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe("ambiguous-default");
      expect(result.failure.candidates).toEqual(["a", "b"]);
    }
  });

  test("fails ambiguous remainder when multiple engines remain without a default", () => {
    const result = selectFileSyncCandidate([candidate("one"), candidate("two")], {
      platform: "linux",
      bindMountPerformance: "slow",
      fileSyncTargets: "prepared-volume",
    });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe("ambiguous");
      expect(result.failure.candidates).toEqual(["one", "two"]);
    }
  });

  test("fails when the selected engine lacks required two-way-safe", () => {
    const unsafe = candidate("unsafe", {
      capabilities: baseCapabilities({ modes: ["one-way-replica"] }),
      defaultFor: { bindMountPerformance: ["slow"] },
    });
    const result = selectFileSyncCandidate([unsafe], {
      platform: "linux",
      bindMountPerformance: "slow",
      fileSyncTargets: "prepared-volume",
      defaultEngine: "unsafe",
    });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe("capabilities");
      expect(result.failure.engineId).toBe("unsafe");
    }
  });

  test("maps wsl hosts to the linux platform family for defaultFor", () => {
    const linuxDefault = candidate("linux-default", {
      defaultFor: { platform: ["linux"], bindMountPerformance: ["slow"] },
    });
    const result = selectFileSyncCandidate([linuxDefault, candidate("other")], {
      platform: "wsl",
      bindMountPerformance: "slow",
      fileSyncTargets: "prepared-volume",
    });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success?.id).toBe("linux-default");
  });
});

const descriptor = (
  id: string,
  options: {
    readonly capabilities?: FileSyncEngineCapabilities;
    readonly defaultFor?: FileSyncEngineDescriptor["defaultFor"];
  } = {},
): FileSyncEngineDescriptor => ({
  id,
  supports: { platform: ["linux", "darwin", "win32"] },
  capabilities: options.capabilities ?? baseCapabilities(),
  ...(options.defaultFor === undefined ? {} : { defaultFor: options.defaultFor }),
});

const countedEngine = (
  id: string,
  calls: Array<string>,
  capabilities: FileSyncEngineCapabilities = baseCapabilities(),
): FileSyncEngineShape => {
  const engine: FileSyncEngineShape = {
    ...TestFileSyncEngine,
    id,
    displayName: id,
    capabilities,
    isAvailable: Effect.sync(() => {
      calls.push(`available:${id}`);
      return true;
    }),
    setup: () =>
      Effect.sync(() => {
        calls.push(`setup:${id}`);
      }),
    bindPreparedTargets: (plan) =>
      Effect.succeed({ ...engine, boundApp: { kind: "user", id: plan.id, root: plan.root } }),
  };
  return engine;
};

const makeModule = (
  name: string,
  engines: ReadonlyArray<{
    readonly id: string;
    readonly capabilities?: FileSyncEngineCapabilities;
    readonly defaultFor?: FileSyncEngineDescriptor["defaultFor"];
    readonly factory?: (ctx: LandoPluginContext) => Layer.Layer<FileSyncEngine, never, never>;
  }>,
  calls: Array<string>,
  contexts: Array<string>,
): LandoPluginModule => ({
  name,
  manifest: Schema.decodeSync(PluginManifest)({
    name,
    version: "1.0.0",
    api: 4,
    contributes: {
      fileSyncEngines: engines.map((engine) =>
        descriptor(engine.id, {
          ...(engine.capabilities === undefined ? {} : { capabilities: engine.capabilities }),
          ...(engine.defaultFor === undefined ? {} : { defaultFor: engine.defaultFor }),
        }),
      ),
    },
  }),
  fileSyncEngines: new Map(
    engines.map((engine) => [
      engine.id,
      {
        make: (ctx: LandoPluginContext) => {
          contexts.push(`${name}:${engine.id}:${ctx.id}`);
          calls.push(`make:${engine.id}`);
          if (engine.factory !== undefined) return engine.factory(ctx);
          return Layer.succeed(
            FileSyncEngine,
            countedEngine(engine.id, calls, engine.capabilities ?? baseCapabilities()),
          );
        },
      },
    ]),
  ),
});

const graphLayer = (
  plugins: ReadonlyArray<{
    readonly source: "bundled" | "user" | "explicit";
    readonly entry: LandoPluginModule;
  }>,
  hostContext: Context.Context<never> = Context.empty(),
) =>
  Layer.succeed(
    PluginContributionGraph,
    PluginContributionGraph.of({
      plugins: plugins.map(({ source, entry }) => ({
        source,
        manifest: entry.manifest,
        entry,
        module: entry,
      })),
      globalPlugins: plugins.map(({ source, entry }) => ({
        source,
        manifest: entry.manifest,
        entry,
        module: entry,
      })),
      certificateAuthorities: [],
      commands: [],
      hostContext,
    }),
  );

const noopProcessRunner = ProcessRunner.of({
  run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
  stream: () => Stream.empty,
  streamWithExit: () => Stream.empty,
});

const resolverDeps = async () => {
  const store = await Effect.runPromise(makeTestManagedFileStore());
  const state = makeTestStateStore();
  const downloader = await Effect.runPromise(makeTestDownloader());
  return Layer.mergeAll(
    Layer.succeed(PathsService, makeLandoPaths()),
    Layer.succeed(ManagedFileService, store.service),
    Layer.succeed(StateStore, state.service),
    Layer.succeed(PrivateFileAccessService, ownerOnlyFileAccess),
    Layer.succeed(HttpClient.HttpClient, stubHttpClient()),
    Layer.succeed(Downloader, downloader.service),
    Layer.succeed(ProcessRunner, noopProcessRunner),
  );
};

describe("FileSyncResolver", () => {
  test("loads a contained installed module through its make context", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-sync-factory-"));
    try {
      await writeFile(
        join(root, "factory.ts"),
        `
        import { Layer } from ${JSON.stringify(import.meta.resolve("effect"))};
        import { FileSyncEngine } from ${JSON.stringify(import.meta.resolve("@lando/sdk/services"))};
        import { TestFileSyncEngine } from ${JSON.stringify(import.meta.resolve("@lando/sdk/test"))};
        export const fileSyncEngine = { make: (ctx) => Layer.succeed(FileSyncEngine, {
          ...TestFileSyncEngine, id: "disk", displayName: ctx.id,
        }) };
      `,
      );
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "@test/disk-sync",
          version: "1.0.0",
          api: 4,
          contributes: {
            fileSyncEngines: [
              {
                id: "disk",
                module: "./factory.ts",
                supports: { platform: ["linux"] },
                capabilities: TestFileSyncEngine.capabilities,
              },
            ],
          },
        }),
      );
      const manifest = await loadInstalledPluginManifest(root);
      const deps = await resolverDeps();
      const layer = FileSyncResolver.layer.pipe(
        Layer.provide(graphLayer([{ source: "user", entry: { name: String(manifest.name), manifest } }])),
        Layer.provide(deps),
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const resolver = yield* FileSyncResolver;
            const engine = yield* resolver.acquire("disk");
            expect(engine.id).toBe("disk");
            expect(engine.displayName).toBe("@test/disk-sync");
          }).pipe(Effect.provide(layer)),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recorded-id acquisition rejects duplicate contributions without constructing either", async () => {
    const calls: string[] = [];
    const one = makeModule("@test/one", [{ id: "duplicate" }], calls, []);
    const two = makeModule("@test/two", [{ id: "duplicate" }], calls, []);
    const deps = await resolverDeps();
    const layer = FileSyncResolver.layer.pipe(
      Layer.provide(
        graphLayer([
          { source: "bundled", entry: one },
          { source: "explicit", entry: two },
        ]),
      ),
      Layer.provide(deps),
    );
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const resolver = yield* FileSyncResolver;
          return yield* Effect.result(resolver.acquire("duplicate"));
        }).pipe(Effect.provide(layer)),
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(calls).toEqual([]);
  });

  test("cached engines release their resources with the resolver scope", async () => {
    const calls: string[] = [];
    const plugin = makeModule(
      "@test/scoped",
      [
        {
          id: "scoped",
          factory: () =>
            Layer.effect(
              FileSyncEngine,
              Effect.acquireRelease(Effect.succeed(countedEngine("scoped", calls)), () =>
                Effect.sync(() => {
                  calls.push("released");
                }),
              ),
            ),
        },
      ],
      calls,
      [],
    );
    const deps = await resolverDeps();
    const layer = FileSyncResolver.layer.pipe(
      Layer.provide(graphLayer([{ source: "explicit", entry: plugin }])),
      Layer.provide(deps),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const resolver = yield* FileSyncResolver;
          const one = yield* resolver.acquire("scoped");
          const two = yield* resolver.acquire("scoped");
          expect(one).toBe(two);
          expect(calls).toEqual(["make:scoped"]);
        }).pipe(Effect.provide(layer)),
      ),
    );
    expect(calls).toEqual(["make:scoped", "released"]);
  });

  test("exposes candidate metadata from enabled graph plugins", async () => {
    const calls: Array<string> = [];
    const contexts: Array<string> = [];
    const alpha = makeModule(
      "@acme/alpha",
      [{ id: "alpha", defaultFor: { bindMountPerformance: ["slow"] } }],
      calls,
      contexts,
    );
    const beta = makeModule("@acme/beta", [{ id: "beta" }], calls, contexts);
    const deps = await resolverDeps();
    const layer = FileSyncResolver.layer.pipe(
      Layer.provide(
        graphLayer([
          { source: "bundled", entry: alpha },
          { source: "user", entry: beta },
        ]),
      ),
      Layer.provide(deps),
    );

    const ids = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const resolver = yield* FileSyncResolver;
          return resolver.candidates.map((entry) => entry.id);
        }).pipe(Effect.provide(layer)),
      ),
    );

    expect(ids).toEqual(["alpha", "beta"]);
    expect(calls).toEqual([]);
  });

  test("selects configured alternative, unique default, and sole engine", async () => {
    const calls: Array<string> = [];
    const contexts: Array<string> = [];
    const bundled = makeModule(
      "@lando/bundled",
      [
        {
          id: "mutagen",
          defaultFor: { platform: ["linux", "darwin", "win32"], bindMountPerformance: ["slow"] },
        },
      ],
      calls,
      contexts,
    );
    const alt = makeModule("@acme/alt", [{ id: "alt" }], calls, contexts);
    const deps = await resolverDeps();
    const layer = FileSyncResolver.layer.pipe(
      Layer.provide(
        graphLayer([
          { source: "bundled", entry: bundled },
          { source: "explicit", entry: alt },
        ]),
      ),
      Layer.provide(deps),
    );

    const selected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const resolver = yield* FileSyncResolver;
          const configured = yield* resolver.select({
            platform: "linux",
            bindMountPerformance: "slow",
            fileSyncTargets: "prepared-volume",
            defaultEngine: "alt",
          });
          const byDefault = yield* resolver.select({
            platform: "linux",
            bindMountPerformance: "slow",
            fileSyncTargets: "prepared-volume",
          });
          return { configured: configured?.id, byDefault: byDefault?.id };
        }).pipe(Effect.provide(layer)),
      ),
    );
    expect(selected).toEqual({ configured: "alt", byDefault: "mutagen" });

    const soleLayer = FileSyncResolver.layer.pipe(
      Layer.provide(graphLayer([{ source: "bundled", entry: alt }])),
      Layer.provide(deps),
    );
    const sole = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const resolver = yield* FileSyncResolver;
          return yield* resolver.select({
            platform: "win32",
            bindMountPerformance: "slow",
            fileSyncTargets: "prepared-volume",
          });
        }).pipe(Effect.provide(soleLayer)),
      ),
    );
    expect(sole?.id).toBe("alt");
  });

  test("selection is stable when contribution order is reversed", async () => {
    const calls: Array<string> = [];
    const contexts: Array<string> = [];
    const first = makeModule(
      "@acme/first",
      [{ id: "first", defaultFor: { bindMountPerformance: ["slow"] } }],
      calls,
      contexts,
    );
    const second = makeModule("@acme/second", [{ id: "second" }], calls, contexts);
    const deps = await resolverDeps();

    const selectFrom = async (plugins: Parameters<typeof graphLayer>[0]) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const resolver = yield* FileSyncResolver;
            return yield* resolver.select({
              platform: "linux",
              bindMountPerformance: "slow",
              fileSyncTargets: "prepared-volume",
            });
          }).pipe(
            Effect.provide(
              FileSyncResolver.layer.pipe(Layer.provide(graphLayer(plugins)), Layer.provide(deps)),
            ),
          ),
        ),
      );

    const forward = await selectFrom([
      { source: "bundled", entry: first },
      { source: "user", entry: second },
    ]);
    const reverse = await selectFrom([
      { source: "user", entry: second },
      { source: "bundled", entry: first },
    ]);
    expect(forward?.id).toBe("first");
    expect(reverse?.id).toBe("first");
  });

  test("native and passthrough select undefined and acquire zero engines", async () => {
    const calls: Array<string> = [];
    const contexts: Array<string> = [];
    const module = makeModule(
      "@acme/engine",
      [{ id: "engine", defaultFor: { bindMountPerformance: ["slow"] } }],
      calls,
      contexts,
    );
    const deps = await resolverDeps();
    const layer = FileSyncResolver.layer.pipe(
      Layer.provide(graphLayer([{ source: "bundled", entry: module }])),
      Layer.provide(deps),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const resolver = yield* FileSyncResolver;
          expect(
            yield* resolver.select({ platform: "linux", bindMountPerformance: "native" }),
          ).toBeUndefined();
          expect(
            yield* resolver.select({
              platform: "linux",
              bindMountPerformance: "slow",
              fileSyncTargets: "prepared-volume",
              defaultEngine: "passthrough",
            }),
          ).toBeUndefined();
        }).pipe(Effect.provide(layer)),
      ),
    );
    expect(calls).toEqual([]);
  });

  test("acquire caches unbound engines by id within the resolver scope", async () => {
    const calls: Array<string> = [];
    const contexts: Array<string> = [];
    const module = makeModule(
      "@acme/cache",
      [
        { id: "alpha", capabilities: baseCapabilities() },
        {
          id: "beta",
          capabilities: baseCapabilities({ exclusionPatterns: false, remoteAgentDeployment: "auto" }),
        },
      ],
      calls,
      contexts,
    );
    const deps = await resolverDeps();
    const layer = FileSyncResolver.layer.pipe(
      Layer.provide(graphLayer([{ source: "bundled", entry: module }])),
      Layer.provide(deps),
    );

    const ids = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const resolver = yield* FileSyncResolver;
          const first = yield* resolver.acquire("alpha");
          const second = yield* resolver.acquire("alpha");
          const other = yield* resolver.acquire("beta");
          expect(first).toBe(second);
          expect(other).not.toBe(first);
          if (first.bindPreparedTargets === undefined) throw new Error("expected binding factory");
          const plan = (name: string) =>
            Schema.decodeUnknownSync(AppPlan)({
              id: name,
              name,
              slug: name,
              root: `/tmp/${name}`,
              provider: "test",
              valueModel: 1,
              services: {},
              routes: [],
              stores: [],
              fileSync: [],
              extensions: {},
              metadata: { resolvedAt: "2026-10-27T00:00:00Z", source: `/tmp/${name}/.lando.yml`, runtime: 4 },
            });
          const bound = yield* first.bindPreparedTargets(plan("first-app"), []);
          const otherBound = yield* first.bindPreparedTargets(plan("second-app"), []);
          expect(bound).not.toBe(first);
          expect(bound.boundApp.id).toBe("first-app");
          expect(otherBound.boundApp.id).toBe("second-app");
          const again = yield* resolver.acquire("alpha");
          expect(again).toBe(first);
          expect("boundApp" in again).toBe(false);
          return [first.id, other.id] as const;
        }).pipe(Effect.provide(layer)),
      ),
    );

    expect(ids).toEqual(["alpha", "beta"]);
    expect(calls.filter((call) => call.startsWith("make:"))).toEqual(["make:alpha", "make:beta"]);
    expect(contexts).toEqual(["@acme/cache:alpha:@acme/cache", "@acme/cache:beta:@acme/cache"]);
  });

  test("acquire maps metadata mismatches to FileSyncStartError", async () => {
    const calls: Array<string> = [];
    const contexts: Array<string> = [];
    const module = makeModule(
      "@acme/mismatch",
      [
        {
          id: "declared",
          factory: () =>
            Layer.succeed(FileSyncEngine, {
              ...TestFileSyncEngine,
              id: "other",
              capabilities: baseCapabilities(),
            }),
        },
      ],
      calls,
      contexts,
    );
    const deps = await resolverDeps();
    const layer = FileSyncResolver.layer.pipe(
      Layer.provide(graphLayer([{ source: "bundled", entry: module }])),
      Layer.provide(deps),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const resolver = yield* FileSyncResolver;
          return yield* resolver.acquire("declared");
        }).pipe(Effect.provide(layer)),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("acquire rejects planning-sensitive capability drift but ignores reporting flags", async () => {
    const calls: Array<string> = [];
    const contexts: Array<string> = [];
    const ok = makeModule(
      "@acme/ok",
      [
        {
          id: "report-drift",
          capabilities: baseCapabilities({ conflictReporting: false, progressReporting: false }),
          factory: () =>
            Layer.succeed(FileSyncEngine, {
              ...TestFileSyncEngine,
              id: "report-drift",
              capabilities: baseCapabilities({ conflictReporting: true, progressReporting: true }),
            }),
        },
      ],
      calls,
      contexts,
    );
    const bad = makeModule(
      "@acme/bad",
      [
        {
          id: "mode-drift",
          capabilities: baseCapabilities({ modes: ["two-way-safe"] }),
          factory: () =>
            Layer.succeed(FileSyncEngine, {
              ...TestFileSyncEngine,
              id: "mode-drift",
              capabilities: baseCapabilities({ modes: ["one-way-safe"] }),
            }),
        },
      ],
      calls,
      contexts,
    );
    const deps = await resolverDeps();

    const reportOk = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const resolver = yield* FileSyncResolver;
          return yield* resolver.acquire("report-drift");
        }).pipe(
          Effect.provide(
            FileSyncResolver.layer.pipe(
              Layer.provide(graphLayer([{ source: "bundled", entry: ok }])),
              Layer.provide(deps),
            ),
          ),
        ),
      ),
    );
    expect(reportOk.id).toBe("report-drift");

    const modeExit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const resolver = yield* FileSyncResolver;
          return yield* resolver.acquire("mode-drift");
        }).pipe(
          Effect.provide(
            FileSyncResolver.layer.pipe(
              Layer.provide(graphLayer([{ source: "bundled", entry: bad }])),
              Layer.provide(deps),
            ),
          ),
        ),
      ),
    );
    expect(modeExit._tag).toBe("Failure");
    const mountResult = await Effect.runPromise(
      Effect.scoped(
        Effect.result(
          resolveFileSyncMountPlan(
            {
              ...acceleratedPlan,
              fileSync: acceleratedPlan.fileSync.map((entry) => ({ ...entry, engineId: "mode-drift" })),
            },
            () => Effect.die("Capability disagreement must not reach ordinary fallback"),
          ).pipe(
            Effect.provide(
              FileSyncResolver.layer.pipe(
                Layer.provide(graphLayer([{ source: "bundled", entry: bad }])),
                Layer.provide(deps),
              ),
            ),
          ),
        ),
      ),
    );
    expect(mountResult._tag).toBe("Failure");
    if (mountResult._tag === "Failure")
      expect(mountResult.failure.message).toContain("capabilities disagree");
  });

  test("surfaces typed selection failures through select", async () => {
    const calls: Array<string> = [];
    const contexts: Array<string> = [];
    const one = makeModule("@acme/one", [{ id: "one" }], calls, contexts);
    const two = makeModule("@acme/two", [{ id: "two" }], calls, contexts);
    const deps = await resolverDeps();
    const layer = FileSyncResolver.layer.pipe(
      Layer.provide(
        graphLayer([
          { source: "bundled", entry: one },
          { source: "user", entry: two },
        ]),
      ),
      Layer.provide(deps),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const resolver = yield* FileSyncResolver;
          return yield* resolver.select({
            platform: "linux",
            bindMountPerformance: "slow",
            fileSyncTargets: "prepared-volume",
          });
        }).pipe(Effect.provide(layer)),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("does not infer platform support from a bare hostContext engine", async () => {
    const host = {
      ...TestFileSyncEngine,
      id: "host-engine",
      capabilities: baseCapabilities(),
    };
    const deps = await resolverDeps();
    const layer = FileSyncResolver.layer.pipe(
      Layer.provide(graphLayer([], Context.make(FileSyncEngine, host))),
      Layer.provide(deps),
    );

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const resolver = yield* FileSyncResolver;
          expect(resolver.candidates).toEqual([]);
          const selected = yield* resolver.select({
            platform: "linux",
            bindMountPerformance: "slow",
            fileSyncTargets: "prepared-volume",
          });
          const acquired = yield* Effect.result(resolver.acquire("host-engine"));
          return { selected: selected?.id, acquisition: acquired._tag };
        }).pipe(Effect.provide(layer)),
      ),
    );
    expect(result).toEqual({ selected: undefined, acquisition: "Failure" });
  });
});
