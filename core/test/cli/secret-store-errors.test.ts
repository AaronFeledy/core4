import { expect, test } from "bun:test";
import { makeTestRuntime } from "@lando/core/testing";
import { StartAppResultSchema, startApp } from "@lando/engine/operations/start";
import {
  RoutedSecretStoreLive,
  makeSecretStoreRegistryLive,
} from "@lando/engine/services/secret-store-registry";
import { makeShellRunnerLive } from "@lando/engine/services/shell-runner";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { makeLandoPaths } from "@lando/paths";
import { RedactionServiceLive } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { SecretStoreUnavailableError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { AppPlan, CommandResultEnvelope, PluginManifest } from "@lando/sdk/schema";
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
import { NoopTransactionGuardLive } from "../_support/landofile-layer.ts";

const unavailable = new SecretStoreUnavailableError({
  storeId: "fake-vault",
  reason: "cli-missing",
  message: "The secret store executable is unavailable.",
  remediation: "Install the secret store CLI and retry lando start.",
});

const renderStartFailure = async (reference: string) => {
  const reads: string[] = [];
  const applies: string[] = [];
  const provider = {
    ...TestRuntimeProvider,
    apply: () =>
      Effect.sync(() => {
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
        Layer.succeed(SecretStore, {
          id: "fake-vault",
          schemes: ["fake"],
          get: (id) => Effect.sync(() => reads.push(id)).pipe(Effect.zipRight(Effect.fail(unavailable))),
          has: () => Effect.fail(unavailable),
          list: Effect.succeed([]),
        }),
      ],
    ]),
  };
  const store = RoutedSecretStoreLive.pipe(
    Layer.provide(Layer.mergeAll(base.layer, paths, makeSecretStoreRegistryLive([plugin]))),
  );
  const metadata = { resolvedAt: "2026-06-01T00:00:00Z", source: "cli-test", runtime: 4 };
  const plan = Schema.decodeUnknownSync(AppPlan)({
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
        environment: { DISPLAY_VALUE: reference },
        mounts: [],
        storage: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata,
        extensions: {},
      },
    },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  });
  const runtime = Layer.mergeAll(
    base.layer,
    paths,
    store,
    RedactionServiceLive.pipe(Layer.provide(store)),
    NoopTransactionGuardLive,
    Layer.succeed(StateStore, makeTestStateStore().service),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
    Layer.succeed(RouterService, TestRouterService),
    Layer.succeed(BuildOrchestrator, {
      build: (value) => Effect.succeed(value),
      buildApp: () => Effect.void,
    }),
    makeShellRunnerLive(() => {
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
    formatError: String,
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
  const result = await renderStartFailure(`\${secret:${reference}}`);
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

test("start renders SecretReferenceInvalidError for a malformed op reference before reading a store", async () => {
  // Given
  const reference = "op://Vault";
  // When
  const result = await renderStartFailure(`\${secret:${reference}}`);
  // Then
  expect(result.reads).toEqual([]);
  expect(result.applies).toEqual([]);
  expect(result.exits).toEqual([1]);
  expect(result.envelope).toMatchObject({
    command: "app:start",
    ok: false,
    error: { _tag: "SecretReferenceInvalidError", remediation: expect.stringMatching(/\S/) },
  });
  expect(result.io.stderr()).toBe("");
});
