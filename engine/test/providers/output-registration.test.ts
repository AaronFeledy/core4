import { afterEach, expect, test } from "bun:test";
import { makeTestManagedFileStore } from "@lando/managed-file/testing";
import { makeLandoPaths } from "@lando/paths";
import {
  RedactionService,
  createStandaloneRedactor,
  makeRedactionService,
  resetRegisteredRedactionValuesForTesting,
} from "@lando/redaction/service";
import { PluginLoadError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import {
  AppPlan,
  GlobalConfig,
  PluginManifest,
  PortablePath,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import {
  AppPlanSanitizer,
  ConfigService,
  ContainerHelperAssets,
  Downloader,
  ManagedFileService,
  PathsService,
  PluginRegistry,
  type ProviderError,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Redacted, Schema, type Scope, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { providerMemberPolicy } from "../../src/providers/output-policy.ts";
import { makeRuntimeProviderRegistry } from "../../src/providers/registry.ts";
import { makeTestDownloader } from "../../src/testing/downloader.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

afterEach(resetRegisteredRedactionValuesForTesting);

const plan = Schema.decodeUnknownSync(AppPlan)({
  id: "output-boundary",
  name: "output-boundary",
  slug: "output-boundary",
  root: "/tmp/output-boundary",
  provider: "test",
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata: { resolvedAt: "2026-10-21T00:00:00Z", source: "test", runtime: 4 },
});
const target = { app: plan.id, service: ServiceName.make("web") };
const command = { command: ["printenv"] };
const spec = { owner: target, image: "test", command: ["printenv"] };
const canary = "registry-environment-private";
const registryLayer = (provider: RuntimeProviderShape) => {
  const id = ProviderId.make(provider.id);
  const manifest = Schema.decodeUnknownSync(PluginManifest)({
    name: "@test/output",
    version: "1.0.0",
    api: 4,
    contributes: { providers: [id] },
  });
  const modules: ReadonlyArray<LandoPluginModule> = [
    {
      name: manifest.name,
      manifest,
      runtimeProviders: new Map([
        [
          id,
          {
            id,
            appliedPlans: () => Effect.succeed([plan]),
            make: () => Effect.succeed(provider),
          },
        ],
      ]),
    },
  ];
  const config = Schema.decodeUnknownSync(GlobalConfig)({ defaultProviderId: id });
  const unsupported = (name: string) =>
    Effect.fail(new PluginLoadError({ message: "unused", pluginName: name }));
  return makeRuntimeProviderRegistry(modules, {
    enforce: async () => undefined,
    verify: async () => undefined,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ConfigService, {
          load: Effect.succeed(config),
          get: (key) => Effect.succeed(config[key]),
        }),
        Layer.succeed(PluginRegistry, {
          list: Effect.succeed([manifest]),
          load: unsupported,
          loadServiceType: unsupported,
          loadServiceFeature: unsupported,
          loadAppFeature: unsupported,
        }),
        Layer.succeed(Downloader, Effect.runSync(makeTestDownloader()).service),
        Layer.succeed(ContainerHelperAssets, { resolve: () => Effect.die("unused helper") }),
        Layer.succeed(ManagedFileService, Effect.runSync(makeTestManagedFileStore()).service),
        Layer.succeed(
          PathsService,
          makeLandoPaths({ userDataRoot: `/tmp/output-boundary-${crypto.randomUUID()}` }),
        ),
        Layer.succeed(StateStore, makeTestStateStore().service),
        Layer.succeed(AppPlanSanitizer, { sanitizeForPersistence: (value) => value }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null))),
          ),
        ),
        Layer.succeed(
          RedactionService,
          makeRedactionService({
            id: "empty",
            list: Effect.succeed([]),
            get: () => Effect.die("must not resolve stores"),
            has: () => Effect.succeed(false),
          }),
        ),
      ),
    ),
  );
};

type OutputMethod = "exec" | "execStream" | "logs" | "run" | "runStream" | "copyFromService";
type Invoke = (provider: RuntimeProviderShape) => Effect.Effect<unknown, ProviderError, Scope.Scope>;
const calls: Readonly<Record<OutputMethod, Invoke>> = {
  exec: (provider: RuntimeProviderShape) => provider.exec(target, command),
  execStream: (provider: RuntimeProviderShape) => Stream.runCollect(provider.execStream(target, command)),
  logs: (provider: RuntimeProviderShape) => Stream.runCollect(provider.logs(target, { follow: false })),
  run: (provider: RuntimeProviderShape) => provider.run(spec),
  runStream: (provider: RuntimeProviderShape) => Stream.runCollect(provider.runStream(spec)),
  copyFromService: (provider: RuntimeProviderShape) =>
    Stream.runCollect(provider.copyFromService(target, { sourcePath: PortablePath.make("/file") })),
};

const outputProvider = (emit: () => string): RuntimeProviderShape => ({
  ...TestRuntimeProvider,
  exec: () => Effect.sync(() => ({ exitCode: 0, stdout: emit(), stderr: "" })),
  execStream: () => Stream.make({ kind: "stdout", chunk: new TextEncoder().encode(emit()) }),
  logs: () => Stream.make({ service: target.service, stream: "stdout", line: emit() }),
  run: () => Effect.sync(() => ({ exitCode: 0, stdout: emit(), stderr: "" })),
  runStream: () => Stream.make({ kind: "stderr", chunk: new TextEncoder().encode(emit()) }),
  copyFromService: () => Stream.make(new TextEncoder().encode(emit())),
});

test.each(Object.entries(calls))("%s registers before its first output", async (_member, invoke) => {
  resetRegisteredRedactionValuesForTesting();
  const observations: string[] = [];
  let reads = 0;
  const emit = () => {
    observations.push(createStandaloneRedactor("secrets").redactString(canary));
    return canary;
  };
  const provider: RuntimeProviderShape = {
    ...outputProvider(emit),
    readAppEnvironment: () =>
      Effect.sync(() => {
        reads++;
        return [Redacted.make(canary)];
      }),
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(RuntimeProviderRegistry, (registry) =>
        registry.select(plan).pipe(Effect.flatMap(invoke)),
      ),
    ).pipe(Effect.provide(registryLayer(provider))),
  );
  expect(observations).toEqual(["[redacted]"]);
  expect(reads).toBe(1);
});

test.each(Object.entries(calls))(
  "%s fails closed on read failure with no output",
  async (_member, invoke) => {
    resetRegisteredRedactionValuesForTesting();
    let outputs = 0;
    const emit = () => {
      outputs++;
      return canary;
    };
    const provider: RuntimeProviderShape = {
      ...outputProvider(emit),
      readAppEnvironment: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "test",
            operation: "readAppEnvironment",
            message: "Read denied",
          }),
        ),
    };
    const result = await Effect.runPromise(
      Effect.result(
        Effect.scoped(
          Effect.flatMap(RuntimeProviderRegistry, (registry) =>
            registry.select(plan).pipe(Effect.flatMap(invoke)),
          ),
        ),
      ).pipe(Effect.provide(registryLayer(provider))),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderUnavailableError", operation: "readAppEnvironment" },
    });
    expect(outputs).toBe(0);
  },
);

test("metadata and lifecycle members never read app environment", async () => {
  let reads = 0;
  const provider = {
    ...TestRuntimeProvider,
    readAppEnvironment: () =>
      Effect.sync(() => {
        reads++;
        return [];
      }),
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const selected = yield* (yield* RuntimeProviderRegistry).select(plan);
        for (const [member, [, errorChannel]] of Object.entries(providerMemberPolicy)) {
          if (errorChannel === "none") {
            expect(Reflect.get(selected, member)).toBe(Reflect.get(provider, member));
          }
        }
        yield* selected.isAvailable;
        yield* selected.getStatus;
        yield* selected.getVersions;
        yield* selected.list({});
        yield* selected.inspect(target);
        yield* selected.start(target);
        yield* selected.stop(target);
        yield* selected.restart(target);
        yield* selected.apply(plan, { reconcile: true });
        yield* selected.run({ image: "test", command: ["true"] });
        yield* Stream.runDrain(selected.runStream({ image: "test", command: ["true"] }));
      }),
    ).pipe(Effect.provide(registryLayer(provider))),
  );
  expect(reads).toBe(0);
});
