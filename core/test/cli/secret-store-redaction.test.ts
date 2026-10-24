import { expect, test } from "bun:test";
import { makeTestRuntime } from "@lando/core/testing";
import { execApp } from "@lando/engine/operations/exec";
import { StartAppResultSchema, startApp } from "@lando/engine/operations/start";
import * as EnvironmentValueResolverLayer from "@lando/engine/services/environment-value-resolver";
import * as RoutedSecretStore from "@lando/engine/services/secret-store-registry";
import * as BunShellRunner from "@lando/engine/services/shell-runner";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import {
  CommandResultEnvelope,
  CurrentExecutableAppPlan,
  PluginManifest,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import { StreamFrame } from "@lando/sdk/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  PathsService,
  RouterService,
  SecretStore,
  StateStore,
} from "@lando/sdk/services";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestRouterService, TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Redacted, Schema, Stream } from "effect";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { EmptyResultSchema } from "../../src/cli/spec/command-base.ts";
import * as TestLandofileLayers from "../_support/landofile-layer.ts";

test.each([
  { failApply: false, providerState: "running", expectedState: "running" },
  { failApply: false, providerState: "opaque", expectedState: "unknown" },
  { failApply: true, providerState: "running", expectedState: "running" },
])(
  "start --format=json redacts scheme-store values (failure $failApply, state $providerState)",
  async ({ failApply, providerState, expectedState }) => {
    // Given: an unguessable value, a neutral env key, and a store that cannot enumerate it.
    const value = `violet-${crypto.randomUUID()}`;
    const reference = "fake://Vault/Item/field";
    const reads: string[] = [];
    const applied: string[] = [];
    const plugin: LandoPluginModule = {
      name: "@test/cli-redaction",
      manifest: Schema.decodeUnknownSync(PluginManifest)({
        name: "@test/cli-redaction",
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
              get: (id) =>
                Effect.sync(() => {
                  reads.push(id);
                  return value;
                }),
              has: () => Effect.succeed(true),
              list: Effect.succeed([]),
            }),
          ),
        ],
      ]),
    };
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      readAppEnvironment: () => Effect.succeed(applied.map((value) => Redacted.make(value))),
      execStream: () =>
        Stream.make(
          { kind: "stdout" as const, chunk: new TextEncoder().encode(value.slice(0, 9)) },
          { kind: "stdout" as const, chunk: new TextEncoder().encode(`${value.slice(9)}\n`) },
          { exitCode: 0 },
        ),
      apply: Effect.fnUntraced(function* (_plan, options) {
        const web = _plan.services[ServiceName.make("web")];
        if (web === undefined || options.resolveServiceEnvironment === undefined)
          throw new TypeError("Expected web environment resolver");
        const resolved = (yield* options.resolveServiceEnvironment(web)).DISPLAY_VALUE ?? "unresolved";
        applied.push(resolved);
        if (failApply)
          return yield* Effect.fail(
            new ProviderUnavailableError({
              providerId: TestRuntimeProvider.id,
              operation: "apply",
              message: `Provider observed ${resolved}`,
            }),
          );
        return { changed: true };
      }),
      inspect: (target) =>
        Effect.succeed({
          app: target.app,
          service: target.service,
          providerId: ProviderId.make(TestRuntimeProvider.id),
          status: "running",
          state: providerState === "opaque" ? `Provider observed ${applied[0]}` : providerState,
          publications: { status: "present", bindings: [] },
        }),
    };
    const base = makeTestRuntime({ bootstrap: "app", with: { RuntimeProvider: provider } });
    const paths = Layer.succeed(PathsService, makeLandoPaths());
    const store = RoutedSecretStore.layer.pipe(
      Layer.provide(Layer.mergeAll(base.layer, paths, RoutedSecretStore.SecretStoreRegistry.layer([plugin]))),
    );
    const redaction = RedactionService.layer.pipe(Layer.provide(store));
    const metadata = { resolvedAt: "2026-06-01T00:00:00Z", source: "cli-test", runtime: 4 };
    const plan = Schema.decodeUnknownSync(CurrentExecutableAppPlan)({
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
          storage: [],
          // Keep a secret in the projected result even when the opaque provider state is discarded.
          endpoints: [{ _tag: "internal", protocol: "tcp", port: 8080, name: value }],
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
      redaction,
      EnvironmentValueResolverLayer.layer.pipe(Layer.fresh, Layer.provide(Layer.mergeAll(store, redaction))),
      TestLandofileLayers.layerTransactionGuard,
      Layer.succeed(StateStore, makeTestStateStore().service),
      Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(plan) })),
      Layer.succeed(RouterService, RouterService.of(TestRouterService)),
      Layer.succeed(
        BuildOrchestrator,
        BuildOrchestrator.of({
          build: (appPlan) => Effect.succeed(appPlan),
          buildApp: () => Effect.void,
        }),
      ),
      BunShellRunner.layer(() => {
        throw new TypeError("Start must not open an interactive shell.");
      }),
    );
    const io = createBufferedRendererIO({ isTTY: false });
    const exits: number[] = [];

    // When: the real start operation resolves the store and the provider echoes its input.
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

    // Then: resolution reached the provider, but neither output channel exposes the value.
    expect(reads, io.stdout() + io.stderr()).toEqual([reference]);
    expect(applied).toEqual([value]);
    expect(io.stdout()).not.toContain(value);
    expect(io.stderr()).not.toContain(value);
    expect(io.stderr()).toBe("");
    const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(io.stdout()));
    expect(envelope).toMatchObject(
      failApply
        ? {
            command: "app:start",
            ok: false,
            error: { _tag: "ProviderUnavailableError", message: "Provider observed [redacted]" },
          }
        : {
            command: "app:start",
            ok: true,
            result: {
              servicesStarted: [
                {
                  name: "web",
                  state: expectedState,
                  connections: [
                    {
                      scope: "app",
                      source: "listener",
                      endpoint: { names: ["[redacted]"] },
                      state: expectedState === "running" ? "active" : "unknown",
                    },
                  ],
                },
              ],
            },
          },
    );
    expect(exits).toEqual(failApply ? [1] : []);
    if (!failApply) {
      const execIo = createBufferedRendererIO({ isTTY: false });
      await runWithRendererHandling(execApp({ service: "web", command: ["printenv", "DISPLAY_VALUE"] }), {
        runtime,
        io: execIo,
        rendererMode: "plain",
        resultFormat: "text",
        command: "app:exec",
        resultSchema: EmptyResultSchema,
        streaming: StreamFrame,
        streamingMode: "live",
        formatError: ({ error }) => String(error),
        setExitCode: (code) => {
          exits.push(code);
        },
      });
      expect(execIo.stdout()).toBe("[redacted]\n");
      expect(execIo.stderr()).not.toContain(value);
      expect(reads).toEqual([reference]);
      expect(exits).toEqual([]);
    }
  },
);
