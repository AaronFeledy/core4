/**
 * `@lando/core/testing` — deterministic Effect service test fixtures.
 */
import { type Context, Effect, Layer, Schema, Stream } from "effect";

import { GlobalConfig } from "@lando/sdk/schema";
import {
  ConfigService,
  FileSystem,
  Logger,
  ProcessRunner,
  type ProcessSpawnOptions,
  RuntimeProvider,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
export { TestRuntimeProvider } from "@lando/sdk/test";
import { TestRuntimeProvider } from "@lando/sdk/test";

type TestBootstrapLevel = "minimal" | "provider" | "global" | "scratch" | "app";

export interface LoggerCall {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface FileSystemCall {
  readonly operation: "readFile" | "writeFile" | "writeAtomic" | "exists";
  readonly path: string;
  readonly content?: string;
}

export interface TestRuntimeCalls {
  readonly logger: LoggerCall[];
  readonly fileSystem: FileSystemCall[];
  readonly processRunner: ProcessSpawnOptions[];
  readonly config: Array<"load" | `get:${string}`>;
}

export interface TestRuntimeOptions {
  readonly bootstrap?: TestBootstrapLevel;
  readonly config?: GlobalConfig;
  readonly files?: Readonly<Record<string, string>>;
  readonly with?: {
    readonly RuntimeProvider?: RuntimeProviderShape;
  };
}

type MinimalTestRuntimeServices = ConfigService | FileSystem | Logger | ProcessRunner;
type ProviderTestRuntimeServices = MinimalTestRuntimeServices | RuntimeProvider;

export interface TestRuntime {
  readonly layer: Layer.Layer<MinimalTestRuntimeServices> | Layer.Layer<ProviderTestRuntimeServices>;
  readonly calls: TestRuntimeCalls;
  readonly files: Map<string, string>;
}

const defaultGlobalConfig: GlobalConfig = Schema.decodeUnknownSync(GlobalConfig)({
  telemetry: { enabled: false },
});

const providerBootstraps = new Set<TestBootstrapLevel>(["provider", "global", "scratch", "app"]);

const recordLoggerCall = (
  calls: TestRuntimeCalls,
  level: LoggerCall["level"],
  message: string,
  data: Readonly<Record<string, unknown>> | undefined,
) => {
  if (data === undefined) {
    calls.logger.push({ level, message });
    return;
  }

  calls.logger.push({ level, message, data });
};

export const makeTestRuntime = (options: TestRuntimeOptions = {}): TestRuntime => {
  const calls: TestRuntimeCalls = {
    logger: [],
    fileSystem: [],
    processRunner: [],
    config: [],
  };
  const files = new Map(Object.entries(options.files ?? {}));
  const config = options.config ?? defaultGlobalConfig;

  const loggerService = {
    debug: (message: string, data?: Readonly<Record<string, unknown>>) =>
      Effect.sync(() => recordLoggerCall(calls, "debug", message, data)),
    info: (message: string, data?: Readonly<Record<string, unknown>>) =>
      Effect.sync(() => recordLoggerCall(calls, "info", message, data)),
    warn: (message: string, data?: Readonly<Record<string, unknown>>) =>
      Effect.sync(() => recordLoggerCall(calls, "warn", message, data)),
    error: (message: string, data?: Readonly<Record<string, unknown>>) =>
      Effect.sync(() => recordLoggerCall(calls, "error", message, data)),
  };

  const fileSystemService = {
    readFile: (path: string) =>
      Effect.sync(() => {
        calls.fileSystem.push({ operation: "readFile", path });
        return files.get(path) ?? "";
      }),
    writeFile: (path: string, content: string) =>
      Effect.sync(() => {
        calls.fileSystem.push({ operation: "writeFile", path, content });
        files.set(path, content);
      }),
    writeAtomic: (path: string, content: string) =>
      Effect.sync(() => {
        calls.fileSystem.push({ operation: "writeAtomic", path, content });
        files.set(path, content);
      }),
    exists: (path: string) =>
      Effect.sync(() => {
        calls.fileSystem.push({ operation: "exists", path });
        return files.has(path);
      }),
  };

  const processRunnerService: Context.Tag.Service<typeof ProcessRunner> = {
    run: (spawnOptions) =>
      Effect.sync(() => {
        calls.processRunner.push(spawnOptions);
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    stream: (spawnOptions) => {
      calls.processRunner.push(spawnOptions);
      return Stream.empty;
    },
  };

  const configService = {
    load: Effect.sync(() => {
      calls.config.push("load");
      return config;
    }),
    get: <K extends keyof GlobalConfig>(key: K) =>
      Effect.sync(() => {
        calls.config.push(`get:${String(key)}`);
        return config[key];
      }),
  };

  const baseLayer = Layer.mergeAll(
    Layer.succeed(Logger, loggerService),
    Layer.succeed(FileSystem, fileSystemService),
    Layer.succeed(ProcessRunner, processRunnerService),
    Layer.succeed(ConfigService, configService),
  );

  const runtimeProvider = options.with?.RuntimeProvider ?? TestRuntimeProvider;
  const layer = providerBootstraps.has(options.bootstrap ?? "minimal")
    ? Layer.mergeAll(baseLayer, Layer.succeed(RuntimeProvider, runtimeProvider))
    : baseLayer;

  return { layer, calls, files };
};

export const provideTestRuntime = (options: TestRuntimeOptions = {}) => makeTestRuntime(options).layer;

export const withService = <I, S>(tag: Context.Tag<I, S>, service: S): Layer.Layer<I> =>
  Layer.succeed(tag, service);

export const TestRuntime = provideTestRuntime({ bootstrap: "provider" });
