import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGlobalPlan } from "@lando/engine/operations/global-plan";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { consumeSites } from "@lando/landofile/compiled-sites";
import { AbsolutePath, AppId, PluginManifest, ProviderId } from "@lando/sdk/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  EnvironmentValueResolver,
  EventService,
  GlobalAppService,
  PluginRegistry,
  RouterService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService } from "@lando/sdk/test";
import { DateTime, Effect, Layer, Result, Schema, Stream } from "effect";
import { compileGlobalConfigDocument } from "../../../src/cli/commands/meta/global-config-document.ts";
import {
  globalConfig,
  globalConfigEdit,
  globalConfigSet,
  globalConfigValidate,
} from "../../../src/cli/commands/meta/global-config.ts";
import { globalStart } from "../../../src/cli/commands/meta/global-start.ts";
import { globalConfigLayer } from "../../_support/global-config-layer.ts";

let root = "";
let planned = 0;
const file = () => join(root, ".lando.yml");
const original = "services:\n  custom:\n    type: compose\n    image: alpine:3.21\n";
const invalid = `${original}    dependsOn: [mailpit]\n`;
const registry = PluginRegistry.of({
  list: Effect.succeed([
    Schema.decodeUnknownSync(PluginManifest)({
      name: "@example/globals",
      version: "1.0.0",
      api: 4,
      contributes: { globalServices: [{ id: "mailpit", enabledByDefault: false }] },
    }),
  ]),
  declaredProviderCapabilities: () => TestRuntimeProvider.capabilities,
  load: () => Effect.die("No plugin should be loaded"),
  loadServiceType: () => Effect.die("No service type should be loaded"),
  loadServiceFeature: () => Effect.die("No service feature should be loaded"),
  loadAppFeature: () => Effect.die("No app feature should be loaded"),
});

const fixture = () =>
  Layer.mergeAll(
    globalConfigLayer(root),
    BunFileSystem.layer,
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        appliedPlansFor: () => Effect.succeed([]),
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        list: Effect.succeed([ProviderId.make("lando")]),
        capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
        select: () => Effect.succeed(TestRuntimeProvider),
      }),
    ),
    Layer.succeed(
      AppPlanner,
      AppPlanner.of({
        plan: (compiled) =>
          Effect.sync(() => {
            planned++;
            const consumed = consumeSites({
              document: compiled.document,
              pendingSites: compiled.pendingSites,
              context: { app: { name: "global" } },
              scopes: ["app"],
            });
            if (Result.isFailure(consumed)) throw consumed.failure;
            expect(consumed.success.document).toMatchObject({
              services: { custom: { dependsOn: [{ service: "global" }] } },
            });
            return {
              valueModel: 1 as const,
              id: AppId.make("global"),
              name: "global",
              slug: "global",
              root: AbsolutePath.make(root),
              provider: ProviderId.make("lando"),
              services: {},
              routes: [],
              stores: [],
              fileSync: [],
              extensions: {},
              metadata: {
                resolvedAt: DateTime.makeUnsafe("1970-01-01T00:00:00Z"),
                source: "test",
                runtime: 4,
              },
            };
          }),
      }),
    ),
  );
type Services = Layer.Success<ReturnType<typeof fixture>>;
const run = <A, E>(body: Effect.Effect<A, E, Services>) =>
  Effect.runPromise(body.pipe(Effect.provideService(PluginRegistry, registry), Effect.provide(fixture())));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-global-config-eligibility-"));
  planned = 0;
  await writeFile(
    join(root, ".lando.dist.yml"),
    "name: global\nruntime: 4\nservices:\n  mailpit:\n    type: compose\n    image: alpine:3.21\n",
  );
  await writeFile(file(), original);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

for (const dryRun of [false, true]) {
  test(`set rejects a dependency on a policy-disabled contribution without changing source (dryRun=${dryRun})`, async () => {
    const result = await run(
      globalConfigSet(
        {
          key: "services.custom.dependsOn",
          value: '["mailpit"]',
          type: "json",
          dryRun,
        },
        file(),
      ).pipe(Effect.result),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "LandofileWriteValidationError",
        issues: [{ path: ["services", "custom", "dependsOn"] }],
      },
    });
    expect(await readFile(file(), "utf8")).toBe(original);
  });
}

test("edit rejects the same effective dependency before saving", async () => {
  const result = await run(
    globalConfigEdit({ editorRunner: async () => ({ kind: "edited", content: invalid }) }, file()).pipe(
      Effect.result,
    ),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "LandofileWriteValidationError" } });
  expect(await readFile(file(), "utf8")).toBe(original);
});

test("validate, view and startup planning reject the same existing invalid dependency", async () => {
  await writeFile(file(), invalid);
  const validation = await run(globalConfigValidate(file()).pipe(Effect.result));
  expect(validation).toMatchObject({ _tag: "Failure", failure: { _tag: "LandofileWriteValidationError" } });
  if (Result.isFailure(validation)) expect(validation.failure.remediation).toContain("required services");
  expect(await run(globalConfig().pipe(Effect.result))).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "GlobalAppError" },
  });
  expect(await run(loadGlobalPlan().pipe(Effect.result))).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "GlobalAppError" },
  });
  const startup = attemptStart();
  expect(await run(startup.pipe(Effect.result))).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "GlobalAppError", operation: "resolution" },
  });
  expect(planned).toBe(0);
});

const attemptStart = () =>
  Effect.gen(function* () {
    const app = yield* GlobalAppService;
    return yield* globalStart({ services: ["custom"] }).pipe(
      Effect.provideService(GlobalAppService, {
        ...app,
        ensureRoot: Effect.void,
        ensureUserLandofile: Effect.succeed({ path: AbsolutePath.make(file()), created: false }),
      }),
      Effect.provideService(BuildOrchestrator, {
        build: () => Effect.die("Invalid config must not build"),
        buildApp: () => Effect.die("Invalid config must not build"),
      }),
      Effect.provideService(EnvironmentValueResolver, {
        openSession: () => Effect.die("Invalid config must not resolve runtime secrets"),
      }),
      Effect.provideService(RouterService, makeTestRouterService()),
      Effect.provideService(EventService, {
        publish: () => Effect.die("Invalid config must not publish lifecycle events"),
        subscribe: () => Stream.die("unused"),
        subscribeQueue: Effect.die("unused"),
        subscribeWithHistory: () => Effect.die("unused"),
        waitFor: () => Effect.die("unused"),
        waitForAny: () => Effect.die("unused"),
        query: () => Effect.die("unused"),
      }),
    );
  });

test("candidate validation retains exact deferred dependency sites through save, view and planning", async () => {
  const deferred = `${original}    dependsOn: ["{{ app.name }}"]\n  global:\n    type: compose\n    image: alpine:3.21\n`;
  const compiled = await run(compileGlobalConfigDocument(file(), deferred));
  expect(compiled.pendingSites.map((site) => site.path)).toContainEqual([
    "services",
    "custom",
    "dependsOn",
    0,
    "service",
  ]);
  await run(globalConfigEdit({ editorRunner: async () => ({ kind: "edited", content: deferred }) }, file()));
  expect(await readFile(file(), "utf8")).toBe(deferred);
  expect(await run(globalConfigValidate(file()))).toMatchObject({ valid: true });
  expect((await run(globalConfig())).landofile?.services).toHaveProperty("custom");
  expect(await run(loadGlobalPlan())).toMatchObject({ materialized: true });
  expect(planned).toBe(1);
});
