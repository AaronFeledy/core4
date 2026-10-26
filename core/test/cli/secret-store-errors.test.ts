import { expect, test } from "bun:test";
import { makeTestRuntime } from "@lando/core/testing";
import { StartAppResultSchema, startApp } from "@lando/engine/operations/start";
import * as EnvironmentValueResolverLayer from "@lando/engine/services/environment-value-resolver";
import * as RoutedSecretStore from "@lando/engine/services/secret-store-registry";
import * as BunShellRunner from "@lando/engine/services/shell-runner";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { SecretStoreUnavailableError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { CommandResultEnvelope, CurrentExecutableAppPlan, PluginManifest } from "@lando/sdk/schema";
import { LandofileService } from "@lando/sdk/services";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import {
  AppPlanner,
  BuildOrchestrator,
  PathsService,
  RouterService,
  SecretStore,
  StateStore,
} from "@lando/sdk/services";
import { TestRouterService, TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import * as TestLandofileLayers from "../_support/landofile-layer.ts";

const unavailable = new SecretStoreUnavailableError({
  storeId: "fake-vault",
  reason: "cli-missing",
  message: "The secret store executable is unavailable.",
  remediation: "Install the secret store CLI and retry lando start.",
});

const renderStartFailure = async (reference: string) => {
  const reads: string[] = [];
  const applies: string[] = [];
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    apply: (plan, options) =>
      Effect.gen(function* () {
        for (const service of Object.values(plan.services)) {
          if (options.resolveServiceEnvironment === undefined)
            throw new TypeError("Expected creation environment resolver");
          yield* options.resolveServiceEnvironment(service);
        }
        applies.push("apply");
        return { changed: true };
      }),
  };
  const base = makeTestRuntime({ bootstrap: "app", with: { RuntimeProvider: provider } });
  const paths = Layer.succeed(PathsService, makeLandoPaths());
  const plugin: LandoPluginModule = {
    name: "@test/cli-errors",
    manifest: Schema.decodeUnknownSync(PluginManifest)({
      name: "@test/cli-errors",
      version: "1.0.0",
      api: 4,
      contributes: { secretStores: [{ id: "fake-vault", module: "./store.ts", schemes: ["fake"] }] },
    }),
    secretStores: new Map([
      [
        "fake-vault",
        Layer.succeed(
          SecretStore,
          SecretStore.of({
            id: "fake-vault",
            schemes: ["fake"],
            get: (id) => Effect.sync(() => reads.push(id)).pipe(Effect.andThen(Effect.fail(unavailable))),
            has: () => Effect.fail(unavailable),
            list: Effect.succeed([]),
          }),
        ),
      ],
    ]),
  };
  const store = RoutedSecretStore.layer.pipe(
    Layer.provide(Layer.mergeAll(base.layer, paths, RoutedSecretStore.SecretStoreRegistry.layer([plugin]))),
  );
  const metadata = { resolvedAt: "2026-06-01T00:00:00Z", source: "cli-test", runtime: 4 };
  const plan = () =>
    Schema.decodeUnknownSync(CurrentExecutableAppPlan)({
      valueModel: 1,
      id: "cli-secrets",
      name: "cli-secrets",
      slug: "cli-secrets",
      root: process.cwd(),
      provider: provider.id,
      services: {
        web: {
          name: "web",
          type: "test",
          provider: provider.id,
          primary: true,
          environment: { DISPLAY_VALUE: { _tag: "SecretRef", reference } },
          mounts: [],
          endpoints: [],
          routes: [],
          dependsOn: [],
          hostAliases: [],
          metadata,
          extensions: {},
        },
      },
      routes: [],
      stores: [],
      fileSync: [],
      metadata,
      extensions: {},
    });
  const runtime = Layer.mergeAll(
    base.layer,
    paths,
    store,
    RedactionService.layer.pipe(Layer.provide(store)),
    EnvironmentValueResolverLayer.layer.pipe(
      Layer.fresh,
      Layer.provide(Layer.mergeAll(store, RedactionService.layer)),
    ),
    TestLandofileLayers.layerTransactionGuard,
    Layer.succeed(StateStore, makeTestStateStore().service),
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover: loadAuthoredDocuments(
          [
            {
              file: `${process.cwd()}/.lando.yml`,
              value: {
                name: "cli-secrets",
                services: {
                  web: { image: "alpine:3.21", environment: { DISPLAY_VALUE: `\${secret:${reference}}` } },
                },
              },
            },
          ],
          { appRoot: process.cwd(), file: `${process.cwd()}/.lando.yml` },
        ),
      }),
    ),
    Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.sync(plan) })),
    Layer.succeed(RouterService, RouterService.of(TestRouterService)),
    Layer.succeed(
      BuildOrchestrator,
      BuildOrchestrator.of({
        build: (value) => Effect.succeed(value),
        buildApp: () => Effect.void,
      }),
    ),
    BunShellRunner.layer(() => {
      throw new TypeError("Start must not open an interactive shell.");
    }),
  );
  const io = createBufferedRendererIO({ isTTY: false });
  const exits: number[] = [];
  await runWithRendererHandling(startApp(), {
    runtime,
    io,
    rendererMode: "json",
    resultFormat: "json",
    command: "app:start",
    resultSchema: StartAppResultSchema,
    formatError: ({ error }) => String(error),
    setExitCode: (code) => {
      exits.push(code);
    },
  });
  return {
    io,
    exits,
    reads,
    applies,
    envelope: Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(io.stdout())),
  };
};

test("start renders the store tag, cli-missing reason and remediation in a JSON error envelope", async () => {
  // Given
  const reference = "fake://Vault/Item/field";
  // When
  const result = await renderStartFailure(reference);
  // Then
  expect(result.reads).toEqual([reference]);
  expect(result.applies).toEqual([]);
  expect(result.exits).toEqual([1]);
  expect(result.envelope).toMatchObject({
    command: "app:start",
    ok: false,
    error: { _tag: unavailable._tag, reason: unavailable.reason, remediation: unavailable.remediation },
  });
  expect(result.io.stderr()).toBe("");
});

test("start rejects a malformed authored op reference before reading a store", async () => {
  // Given
  const reference = "op://Vault";
  // When
  const result = await renderStartFailure(reference);
  // Then
  expect(result.reads).toEqual([]);
  expect(result.applies).toEqual([]);
  expect(result.exits).toEqual([1]);
  expect(result.envelope).toMatchObject({
    command: "app:start",
    ok: false,
    error: { _tag: "ConfigExpressionError", remediation: expect.stringMatching(/\S/) },
  });
  expect(result.io.stderr()).toBe("");
});
