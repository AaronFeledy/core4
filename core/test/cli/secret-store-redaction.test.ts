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
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { AppPlan, CommandResultEnvelope, PluginManifest, ProviderId, ServiceName } from "@lando/sdk/schema";
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
import { Effect, Layer, Schema } from "effect";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { NoopTransactionGuardLive } from "../_support/landofile-layer.ts";

test.each([false, true])(
  "start --format=json redacts scheme-store values when provider failure is %s",
  async (failApply) => {
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
          Layer.succeed(SecretStore, {
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
        ],
      ]),
    };
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      apply: (_plan, options) =>
        Effect.gen(function* () {
          const resolved =
            options.serviceEnvironment?.[ServiceName.make("web")]?.DISPLAY_VALUE ?? "unresolved";
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
          state: `Provider observed ${applied[0]}`,
          endpoints: [],
        }),
    };
    const base = makeTestRuntime({ bootstrap: "app", with: { RuntimeProvider: provider } });
    const paths = Layer.succeed(PathsService, makeLandoPaths());
    const store = RoutedSecretStoreLive.pipe(
      Layer.provide(Layer.mergeAll(base.layer, paths, makeSecretStoreRegistryLive([plugin]))),
    );
    const redaction = RedactionServiceLive.pipe(Layer.provide(store));
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
          environment: { DISPLAY_VALUE: `\${secret:${reference}}` },
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
      redaction,
      NoopTransactionGuardLive,
      Layer.succeed(StateStore, makeTestStateStore().service),
      Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
      Layer.succeed(RouterService, TestRouterService),
      Layer.succeed(BuildOrchestrator, {
        build: (appPlan) => Effect.succeed(appPlan),
        buildApp: () => Effect.void,
      }),
      makeShellRunnerLive(() => {
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
      formatError: String,
      setExitCode: (code) => {
        exits.push(code);
      },
    });

    // Then: resolution reached the provider, but neither output channel exposes the value.
    expect(reads).toEqual([reference]);
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
              servicesStarted: [{ name: "web", state: "Provider observed [redacted]", endpoints: [] }],
            },
          },
    );
    expect(exits).toEqual(failApply ? [1] : []);
  },
);
