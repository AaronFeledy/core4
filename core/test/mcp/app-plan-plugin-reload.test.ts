import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deserialize } from "node:v8";

import { APP_PLAN_CACHE_HEADER_BYTES } from "@lando/engine/cache/app-plan";
import { appPlanCachePath } from "@lando/engine/cache/paths";
import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import { withAppDiscovery } from "@lando/landofile/operation-discovery";
import { AbsolutePath, LandofileShape, LoadScopedLandofile } from "@lando/sdk/schema";
import { AppPlanner, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Context, Effect, Layer, Result, Schema } from "effect";

import "../../src/runtime/bundled-plugins";
import { makeMcpAppGenerations } from "../../src/cli/commands/meta/mcp-app-generations";
import { makeLandoGenerationRuntime } from "../../src/runtime/layer";
import { fixtureRoot, writeFixtureApp } from "./app-fixture";

const planIn = (context: Context.Context<unknown>, root: string) =>
  Context.get(context, AppPlanner).plan(
    LoadScopedLandofile.make({
      stage: "load-scoped",
      document: Schema.decodeUnknownSync(LandofileShape)({
        name: "implementation-cache",
        router: { enabled: false },
        services: { web: { type: "implementation-type", image: "alpine", home: false } },
      }),
      pendingSites: [],
      context: { appRoot: AbsolutePath.make(root), env: {} },
    }),
    TestRuntimeProvider.capabilities,
  );

test("#2105 real app planning hits unchanged plugin code and writes a new cache key after a transitive edit", async () => {
  const parent = await fixtureRoot("plan-reload");
  try {
    const app = await writeFixtureApp(parent, "a", { commands: [], serviceType: "implementation-type" });
    const original = await Bun.file(app.entry).text();
    const child = join(dirname(app.entry), "implementation.ts");
    await writeFile(child, "export const version = 1;");
    await writeFile(app.entry, `import "./implementation.ts";\n${original}`);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = Result.getOrThrow(
            makeLandoGenerationRuntime({
              cwd: app.root,
              interaction: "non-interactive",
              plugins: { policy: "discovery" },
            }),
          );
          const host = yield* Layer.build(runtime.host);
          const apps = yield* makeMcpAppGenerations({ runtime, host, sessionIds: new Set() });
          const plan = Effect.scoped(
            withAppDiscovery(
              app.root,
              Effect.gen(function* () {
                const generation = yield* apps.acquire(app.root);
                return yield* planIn(generation.context, app.root);
              }),
            ),
          );
          const first = yield* plan;
          const cache = appPlanCachePath(
            Context.get(host, PathsService).roots.userCacheRoot,
            first.slug,
            first.root,
          );
          const before = yield* Effect.promise(() => Bun.file(cache).bytes());
          yield* plan;
          const unchanged = yield* Effect.promise(() => Bun.file(cache).bytes());
          expect(unchanged).toEqual(before);
          yield* Effect.promise(() => writeFile(child, "export const version = 2;"));
          yield* plan;
          const after = yield* Effect.promise(() => Bun.file(cache).bytes());
          const cacheKey = (bytes: Uint8Array) =>
            Schema.decodeUnknownSync(Schema.Struct({ key: Schema.String }))(
              deserialize(bytes.subarray(APP_PLAN_CACHE_HEADER_BYTES)),
            ).key;
          expect(cacheKey(after)).not.toBe(cacheKey(before));
        }),
      ),
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 30_000);

test("one-shot app planning skips persistent writes when plugin code changes during import", async () => {
  const parent = await fixtureRoot("plan-import-churn");
  try {
    const app = await writeFixtureApp(parent, "a", { commands: [], serviceType: "implementation-type" });
    await writeFile(
      app.entry,
      `${await Bun.file(app.entry).text()}\nawait Bun.write(new URL("./generated.ts", import.meta.url), "export const generated = 1;");\n`,
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = Result.getOrThrow(
            makeLandoGenerationRuntime({
              cwd: app.root,
              interaction: "non-interactive",
              plugins: { policy: "discovery" },
            }),
          );
          const host = yield* Layer.build(runtime.host);
          const context = yield* Layer.build(runtime.generation({ cwd: app.root, host })).pipe(
            Effect.provide(Context.makeUnsafe<unknown>(host.mapUnsafe)),
          );
          const graph = Context.get(context, PluginContributionGraph);
          expect(graph.plugins.find((plugin) => plugin.source === "app")?.implementationStable).toBe(false);
          const planned = yield* planIn(Context.makeUnsafe<unknown>(context.mapUnsafe), app.root);
          const cache = appPlanCachePath(
            Context.get(host, PathsService).roots.userCacheRoot,
            planned.slug,
            planned.root,
          );
          expect(yield* Effect.promise(() => Bun.file(cache).exists())).toBe(false);
        }),
      ),
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 30_000);

test("planning a service whose plugin failed to import reports that import error and caches nothing", async () => {
  const parent = await fixtureRoot("plan-broken-plugin");
  try {
    const app = await writeFixtureApp(parent, "a", { commands: [], serviceType: "implementation-type" });
    await writeFile(app.entry, "export const broken = ;");
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = Result.getOrThrow(
            makeLandoGenerationRuntime({
              cwd: app.root,
              interaction: "non-interactive",
              plugins: { policy: "discovery" },
            }),
          );
          const host = yield* Layer.build(runtime.host);
          const apps = yield* makeMcpAppGenerations({ runtime, host, sessionIds: new Set() });
          const planned = yield* Effect.scoped(
            withAppDiscovery(
              app.root,
              Effect.gen(function* () {
                const generation = yield* apps.acquire(app.root);
                return yield* planIn(generation.context, app.root);
              }),
            ),
          ).pipe(Effect.flip);
          expect(planned._tag).toBe("LandofileValidationError");
          // The service issue carries the plugin's own import error and its repair step.
          expect(planned.message).toContain(
            "services.web: Failed to import plugin @example/app-a entry index.ts: BuildMessage: Unexpected ;",
          );
          expect(planned.message).toContain(`Repair ${app.entry} for plugin @example/app-a.`);
          expect(planned.message).not.toContain("Unsupported service type");
          const cache = appPlanCachePath(
            Context.get(host, PathsService).roots.userCacheRoot,
            "implementation-cache",
            app.root,
          );
          expect(yield* Effect.promise(() => Bun.file(cache).exists())).toBe(false);
        }),
      ),
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 30_000);
