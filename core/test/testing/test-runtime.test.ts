import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { Context, Effect, Fiber, Layer, Queue, Schema } from "effect";

import {
  AppPlanner,
  CacheService,
  CommandRegistry,
  ConfigService,
  DeprecationService,
  EventService,
  FileSyncEngine,
  FileSystem,
  GlobalAppService,
  LandofileService,
  Logger,
  PluginRegistry,
  PluginTrustStore,
  PrivilegeService,
  ProcessRunner,
  Renderer,
  RuntimeProviderRegistry,
  ScratchAppService,
  SecretStore,
  Telemetry,
  ToolingEngine,
} from "@lando/core/services";
import { TestRuntimeProvider, makeTestRuntime, provideTestRuntime } from "@lando/core/testing";
import { RuntimeProvider } from "@lando/sdk/services";
import { runProviderContract, runProviderContractMatrix } from "@lando/sdk/test";
import { ScratchRegistry } from "../../src/scratch-app/registry.ts";
import { ScratchResourceScanner } from "../../src/scratch-app/scanner.ts";

const CacheValue = Schema.Struct({
  name: Schema.String,
  count: Schema.Number,
});

type LayerOutput<LayerValue> = LayerValue extends Layer.Layer<infer Output, infer _Error, infer _Input>
  ? Output
  : never;

type TypeEquals<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <
  Value,
>() => Value extends Right ? 1 : 2
  ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
    ? true
    : false
  : false;

type AssertType<Value extends true> = Value;

type ScratchOrAppBootstrap = "scratch" | "app";
const makeScratchOrAppRuntime = (bootstrap: ScratchOrAppBootstrap) => makeTestRuntime({ bootstrap });
type ScratchOrAppRuntime = ReturnType<typeof makeScratchOrAppRuntime>;
type ExpectedScratchOrAppServices =
  | Logger
  | Renderer
  | Telemetry
  | ConfigService
  | EventService
  | DeprecationService
  | PluginTrustStore
  | CacheService
  | FileSystem
  | PrivilegeService
  | SecretStore
  | ProcessRunner
  | PluginRegistry
  | RuntimeProviderRegistry
  | RuntimeProvider
  | GlobalAppService
  | AppPlanner
  | LandofileService
  | ScratchAppService
  | ScratchRegistry
  | ScratchResourceScanner
  | CommandRegistry
  | ToolingEngine
  | FileSyncEngine;

const distributiveBootstrapReturnCheck: AssertType<
  TypeEquals<LayerOutput<ScratchOrAppRuntime["layer"]>, ExpectedScratchOrAppServices>
> = true;

describe("@lando/core/testing", () => {
  test("bootstrap union return types remain distributive", () => {
    expect(distributiveBootstrapReturnCheck).toBe(true);
  });

  test("makeTestRuntime provides in-memory service doubles and records calls", async () => {
    const runtime = makeTestRuntime({ files: { "/app/.lando.yml": "name: app" } });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const logger = yield* Logger;
        const fileSystem = yield* FileSystem;
        const processRunner = yield* ProcessRunner;
        const config = yield* ConfigService;

        yield* logger.info("boot", { bootstrap: "minimal" });
        const content = yield* fileSystem.readFile("/app/.lando.yml");
        yield* fileSystem.writeAtomic("/tmp/generated", "ok");
        const processResult = yield* processRunner.run({ cmd: "lando", args: ["version"], cwd: "/app" });
        const globalConfig = yield* config.load;

        return { content, processResult, globalConfig };
      }).pipe(Effect.provide(runtime.layer)),
    );

    expect(result.content).toBe("name: app");
    expect(result.processResult).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(result.globalConfig.telemetry).toEqual({ enabled: false });
    expect(runtime.calls.logger).toEqual([
      { level: "info", message: "boot", data: { bootstrap: "minimal" } },
    ]);
    expect(runtime.calls.fileSystem).toEqual([
      { operation: "readFile", path: "/app/.lando.yml" },
      { operation: "writeAtomic", path: "/tmp/generated", content: "ok" },
    ]);
    expect(runtime.calls.processRunner).toEqual([{ cmd: "lando", args: ["version"], cwd: "/app" }]);
    expect(runtime.calls.config).toEqual(["load"]);
    expect(runtime.files.get("/tmp/generated")).toBe("ok");
  });

  test("provideTestRuntime returns a Layer with default config", async () => {
    const config = await Effect.runPromise(
      Effect.flatMap(ConfigService, (service) => service.load).pipe(
        Effect.provide(provideTestRuntime({ bootstrap: "minimal" })),
      ),
    );

    expect(config.telemetry).toEqual({ enabled: false });
  });

  test("EventService double publishes events to queues and waiters", async () => {
    const runtime = makeTestRuntime({ bootstrap: "minimal" });
    const firstEvent = { _tag: "test-runtime:event", value: 1 };
    const secondEvent = { _tag: "test-runtime:event", value: 2 };

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          const queue = yield* events.subscribeQueue;
          const waiter = yield* events
            .waitFor("test-runtime:event", (event) => event.value === 2)
            .pipe(Effect.fork);

          yield* Effect.sleep("10 millis");
          yield* events.publish(firstEvent);
          const queued = yield* Queue.take(queue);
          yield* events.publish(secondEvent);
          const waited = yield* Fiber.join(waiter);

          return { queued, waited };
        }),
      ).pipe(Effect.provide(runtime.layer)),
    );

    expect(result).toEqual({ queued: firstEvent, waited: secondEvent });
    expect(runtime.calls.events).toEqual([firstEvent, secondEvent]);
  });

  test("CacheService double stores values in memory and reports misses", async () => {
    const runtime = makeTestRuntime({ bootstrap: "minimal" });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* CacheService;

        yield* cache.write("cache:value", { name: "app", count: 1 }, 1);
        const hit = yield* cache.read("cache:value", CacheValue);
        const miss = yield* cache.read("cache:missing", CacheValue);
        yield* cache.writeAtomic("/cache/blob", "payload");

        return { hit, miss, atomic: runtime.files.get("/cache/blob") };
      }).pipe(Effect.provide(runtime.layer)),
    );

    expect(result).toEqual({ hit: { name: "app", count: 1 }, miss: null, atomic: "payload" });
  });

  describe("bootstrap levels provide every tag", () => {
    const bootstrapCases = [
      {
        bootstrap: "minimal",
        verify: async () => {
          const context = await Effect.runPromise(
            Effect.scoped(Layer.build(provideTestRuntime({ bootstrap: "minimal" }))),
          );

          expect(Context.get(context, Logger)).toBeDefined();
          expect(Context.get(context, Renderer)).toBeDefined();
          expect(Context.get(context, Telemetry)).toBeDefined();
          expect(Context.get(context, ConfigService)).toBeDefined();
          expect(Context.get(context, EventService)).toBeDefined();
          expect(Context.get(context, DeprecationService)).toBeDefined();
          expect(Context.get(context, PluginTrustStore)).toBeDefined();
          expect(Context.get(context, CacheService)).toBeDefined();
          expect(Context.get(context, FileSystem)).toBeDefined();
          expect(Context.get(context, PrivilegeService)).toBeDefined();
          expect(Context.get(context, SecretStore)).toBeDefined();
          expect(Context.get(context, ProcessRunner)).toBeDefined();
        },
      },
      {
        bootstrap: "provider",
        verify: async () => {
          const context = await Effect.runPromise(
            Effect.scoped(Layer.build(provideTestRuntime({ bootstrap: "provider" }))),
          );

          expect(Context.get(context, Logger)).toBeDefined();
          expect(Context.get(context, Renderer)).toBeDefined();
          expect(Context.get(context, Telemetry)).toBeDefined();
          expect(Context.get(context, ConfigService)).toBeDefined();
          expect(Context.get(context, EventService)).toBeDefined();
          expect(Context.get(context, DeprecationService)).toBeDefined();
          expect(Context.get(context, PluginTrustStore)).toBeDefined();
          expect(Context.get(context, CacheService)).toBeDefined();
          expect(Context.get(context, FileSystem)).toBeDefined();
          expect(Context.get(context, PrivilegeService)).toBeDefined();
          expect(Context.get(context, SecretStore)).toBeDefined();
          expect(Context.get(context, ProcessRunner)).toBeDefined();
          expect(Context.get(context, PluginRegistry)).toBeDefined();
          expect(Context.get(context, RuntimeProviderRegistry)).toBeDefined();
          expect(Context.get(context, RuntimeProvider)).toBeDefined();
          expect(Context.get(context, GlobalAppService)).toBeDefined();
        },
      },
      {
        bootstrap: "global",
        verify: async () => {
          const context = await Effect.runPromise(
            Effect.scoped(Layer.build(provideTestRuntime({ bootstrap: "global" }))),
          );

          expect(Context.get(context, Logger)).toBeDefined();
          expect(Context.get(context, Renderer)).toBeDefined();
          expect(Context.get(context, Telemetry)).toBeDefined();
          expect(Context.get(context, ConfigService)).toBeDefined();
          expect(Context.get(context, EventService)).toBeDefined();
          expect(Context.get(context, DeprecationService)).toBeDefined();
          expect(Context.get(context, PluginTrustStore)).toBeDefined();
          expect(Context.get(context, CacheService)).toBeDefined();
          expect(Context.get(context, FileSystem)).toBeDefined();
          expect(Context.get(context, PrivilegeService)).toBeDefined();
          expect(Context.get(context, SecretStore)).toBeDefined();
          expect(Context.get(context, ProcessRunner)).toBeDefined();
          expect(Context.get(context, PluginRegistry)).toBeDefined();
          expect(Context.get(context, RuntimeProviderRegistry)).toBeDefined();
          expect(Context.get(context, RuntimeProvider)).toBeDefined();
          expect(Context.get(context, GlobalAppService)).toBeDefined();
          expect(Context.get(context, AppPlanner)).toBeDefined();
        },
      },
      {
        bootstrap: "scratch",
        verify: async () => {
          const context = await Effect.runPromise(
            Effect.scoped(Layer.build(provideTestRuntime({ bootstrap: "scratch" }))),
          );

          expect(Context.get(context, Logger)).toBeDefined();
          expect(Context.get(context, Renderer)).toBeDefined();
          expect(Context.get(context, Telemetry)).toBeDefined();
          expect(Context.get(context, ConfigService)).toBeDefined();
          expect(Context.get(context, EventService)).toBeDefined();
          expect(Context.get(context, DeprecationService)).toBeDefined();
          expect(Context.get(context, PluginTrustStore)).toBeDefined();
          expect(Context.get(context, CacheService)).toBeDefined();
          expect(Context.get(context, FileSystem)).toBeDefined();
          expect(Context.get(context, PrivilegeService)).toBeDefined();
          expect(Context.get(context, SecretStore)).toBeDefined();
          expect(Context.get(context, ProcessRunner)).toBeDefined();
          expect(Context.get(context, PluginRegistry)).toBeDefined();
          expect(Context.get(context, RuntimeProviderRegistry)).toBeDefined();
          expect(Context.get(context, RuntimeProvider)).toBeDefined();
          expect(Context.get(context, GlobalAppService)).toBeDefined();
          expect(Context.get(context, AppPlanner)).toBeDefined();
          expect(Context.get(context, LandofileService)).toBeDefined();
          expect(Context.get(context, ScratchAppService)).toBeDefined();
          expect(Context.get(context, ScratchRegistry)).toBeDefined();
          expect(Context.get(context, ScratchResourceScanner)).toBeDefined();
        },
      },
      {
        bootstrap: "app",
        verify: async () => {
          const context = await Effect.runPromise(
            Effect.scoped(Layer.build(provideTestRuntime({ bootstrap: "app" }))),
          );

          expect(Context.get(context, Logger)).toBeDefined();
          expect(Context.get(context, Renderer)).toBeDefined();
          expect(Context.get(context, Telemetry)).toBeDefined();
          expect(Context.get(context, ConfigService)).toBeDefined();
          expect(Context.get(context, EventService)).toBeDefined();
          expect(Context.get(context, DeprecationService)).toBeDefined();
          expect(Context.get(context, PluginTrustStore)).toBeDefined();
          expect(Context.get(context, CacheService)).toBeDefined();
          expect(Context.get(context, FileSystem)).toBeDefined();
          expect(Context.get(context, PrivilegeService)).toBeDefined();
          expect(Context.get(context, SecretStore)).toBeDefined();
          expect(Context.get(context, ProcessRunner)).toBeDefined();
          expect(Context.get(context, PluginRegistry)).toBeDefined();
          expect(Context.get(context, RuntimeProviderRegistry)).toBeDefined();
          expect(Context.get(context, RuntimeProvider)).toBeDefined();
          expect(Context.get(context, GlobalAppService)).toBeDefined();
          expect(Context.get(context, AppPlanner)).toBeDefined();
          expect(Context.get(context, LandofileService)).toBeDefined();
          expect(Context.get(context, CommandRegistry)).toBeDefined();
          expect(Context.get(context, ToolingEngine)).toBeDefined();
          expect(Context.get(context, FileSyncEngine)).toBeDefined();
        },
      },
    ] as const;

    for (const { bootstrap, verify } of bootstrapCases) {
      test(`${bootstrap} provides every expected tag`, verify);
    }

    test("independent runtimes are deterministic and stay in memory", async () => {
      const virtualPath = "/__lando-test-runtime-deterministic__/file.txt";

      const run = async () => {
        const runtime = makeTestRuntime({ bootstrap: "minimal" });
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem;
            const logger = yield* Logger;
            const renderer = yield* Renderer;

            yield* fileSystem.writeFile(virtualPath, "payload");
            const content = yield* fileSystem.readFile(virtualPath);
            yield* logger.info("deterministic", { content });
            yield* renderer.output.stdout(`content=${content}`);

            return { content, fileInMemory: runtime.files.get(virtualPath) };
          }).pipe(Effect.provide(runtime.layer)),
        );

        return { result, calls: structuredClone(runtime.calls) };
      };

      const first = await run();
      const second = await run();

      expect(first).toEqual(second);
      expect(first.result).toEqual({ content: "payload", fileInMemory: "payload" });
      expect(first.calls.logger).toEqual([
        { level: "info", message: "deterministic", data: { content: "payload" } },
      ]);
      expect(first.calls.renderer).toEqual([{ stream: "stdout", chunk: "content=payload" }]);
      expect(existsSync(virtualPath)).toBe(false);
    });
  });

  test("scratch bootstrap keeps scratch service and registry doubles consistent", async () => {
    const layer = provideTestRuntime({ bootstrap: "scratch" });

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scratch = yield* ScratchAppService;
          const registry = yield* ScratchRegistry;

          const handle = yield* scratch.acquire({
            source: { kind: "recipe", ref: "empty" },
            detached: true,
            isolate: "full",
          });
          const resolved = yield* scratch.resolveById(handle.id);
          const summaries = yield* scratch.list();
          const registryEntry = yield* registry.get(handle.id);
          const registryEntries = yield* registry.list();
          const registryEnvelope = yield* registry.read();
          yield* scratch.destroy(handle.id);
          const summariesAfterDestroy = yield* scratch.list();
          const registryEntriesAfterDestroy = yield* registry.list();

          return {
            handle,
            resolved,
            summaries,
            registryEntry,
            registryEntries,
            registryEnvelope,
            summariesAfterDestroy,
            registryEntriesAfterDestroy,
          };
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(result.resolved).toEqual(result.handle);
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]?.id).toBe(result.handle.id);
    expect(result.registryEntry).toEqual(result.registryEntries[0]);
    expect(result.registryEntries).toEqual(result.registryEnvelope.entries);
    expect(result.registryEntry).toMatchObject({
      id: result.handle.id,
      source: result.summaries[0]?.source,
      isolate: result.summaries[0]?.mode,
      detached: true,
      rootPath: String(result.summaries[0]?.app.root),
      status: "running",
      createdAt: result.summaries[0]?.created,
      updatedAt: result.summaries[0]?.created,
    });
    expect(result.summariesAfterDestroy).toEqual([]);
    expect(result.registryEntriesAfterDestroy).toEqual([]);
  });

  test("provider bootstrap supports RuntimeProvider overrides", async () => {
    const injectedProvider = { ...TestRuntimeProvider, id: "injected-test" };

    const context = await Effect.runPromise(
      Effect.scoped(
        Layer.build(
          provideTestRuntime({
            bootstrap: "provider",
            with: { RuntimeProvider: injectedProvider },
          }),
        ),
      ),
    );
    const provider = Context.get(context, RuntimeProvider);

    expect(provider.id).toBe("injected-test");
  });

  test("re-exported TestRuntimeProvider passes the provider contract", () =>
    Effect.runPromise(runProviderContract(TestRuntimeProvider)).then((result) => {
      expect(result).toBeUndefined();
    }));

  test("provider bootstrap resolves a contract-valid RuntimeProvider from the layer", async () => {
    const context = await Effect.runPromise(
      Effect.scoped(Layer.build(provideTestRuntime({ bootstrap: "provider" }))),
    );
    const provider = Context.get(context, RuntimeProvider);

    const contractResult = await Effect.runPromise(runProviderContract(provider));
    expect(contractResult).toBeUndefined();

    const matrixReport = await Effect.runPromise(
      runProviderContractMatrix({
        providerName: "LayerResolvedTestRuntimeProvider",
        cells: [
          {
            platform: "linux",
            supported: true,
            factory: () => Effect.succeed({ ...provider, platform: "linux" }),
          },
          {
            platform: "darwin",
            supported: false,
            skipReason: "AC3 only exercises the layer-resolved provider on linux",
          },
          {
            platform: "win32",
            supported: false,
            skipReason: "AC3 only exercises the layer-resolved provider on linux",
          },
          {
            platform: "wsl",
            supported: false,
            skipReason: "AC3 only exercises the layer-resolved provider on linux",
          },
        ],
      }),
    );

    expect(matrixReport.providerName).toBe("LayerResolvedTestRuntimeProvider");
    expect(matrixReport.results.map((r) => `${r.platform}:${r.outcome}`)).toEqual([
      "linux:passed",
      "darwin:skipped",
      "win32:skipped",
      "wsl:skipped",
    ]);
  });

  test("matrix: TestRuntimeProvider is portable across linux / darwin / win32", async () => {
    const report = await Effect.runPromise(
      runProviderContractMatrix({
        providerName: "TestRuntimeProvider",
        cells: [
          {
            platform: "linux",
            supported: true,
            factory: () => Effect.succeed({ ...TestRuntimeProvider, platform: "linux" }),
          },
          {
            platform: "darwin",
            supported: true,
            factory: () => Effect.succeed({ ...TestRuntimeProvider, platform: "darwin" }),
          },
          {
            platform: "win32",
            supported: true,
            factory: () => Effect.succeed({ ...TestRuntimeProvider, platform: "win32" }),
          },
          { platform: "wsl", supported: false, skipReason: "TestRuntimeProvider tracks host OS cells only" },
        ],
      }),
    );

    expect(report.providerName).toBe("TestRuntimeProvider");
    expect(report.results.map((r) => `${r.platform}:${r.outcome}`)).toEqual([
      "linux:passed",
      "darwin:passed",
      "win32:passed",
      "wsl:skipped",
    ]);
  });
});
