/**
 * Embedding-host observability: `openLandoRuntime` and `makeLandoRuntime` keep
 * the host's tracer, loggers, minimum log level, and error reporters; Lando
 * spans parent to the host's current span; operation boundaries report defects
 * (never tagged failures) to the host reporter exactly once.
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import {
  Cause,
  Effect,
  ErrorReporter,
  Layer,
  type LogLevel,
  Logger,
  Option,
  References,
  Schema,
  Tracer,
} from "effect";

import { makeLandoRuntime, openLandoRuntime } from "@lando/core";
import { ProviderId } from "@lando/core/schema";
import { RouterService, RuntimeProvider, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { Logger as LandoLogger } from "@lando/sdk/services";
import { TestRouterService } from "@lando/sdk/test";

const testProviderLayers = [
  Layer.succeed(RuntimeProvider, RuntimeProvider.of(TestRuntimeProvider)),
  Layer.succeed(
    RuntimeProviderRegistry,
    RuntimeProviderRegistry.of({
      list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
      capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
      select: () => Effect.succeed(TestRuntimeProvider),
    }),
  ),
  Layer.succeed(RouterService, RouterService.of(TestRouterService)),
];

const plugins = { policy: "bundled-only", layers: testProviderLayers } as const;

class HostVisibleFailure extends Schema.TaggedError<HostVisibleFailure>()("HostVisibleFailure", {}) {}

const withTempApp = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-host-observability-")));
  await Bun.write(
    join(dir, ".lando.yml"),
    `name: host-observed\nruntime: 4\nprovider: ${TestRuntimeProvider.id}\nservices:\n  cache:\n    type: redis\n    primary: true\n`,
  );
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const makeHostTracer = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, tracer };
};

const ancestorNames = (span: Tracer.AnySpan): ReadonlyArray<string> => {
  const names: Array<string> = [];
  let parent = span._tag === "Span" ? span.parent : Option.none();
  while (Option.isSome(parent)) {
    const current = parent.value;
    names.push(current._tag === "Span" ? current.name : `external:${current.spanId}`);
    parent = current._tag === "Span" ? current.parent : Option.none();
  }
  return names;
};

type HostLog = { readonly message: unknown; readonly level: LogLevel.LogLevel };

const makeHostLogger = () => {
  const logs: Array<HostLog> = [];
  const logger = Logger.make<unknown, void>(({ message, logLevel }) => {
    logs.push({ message, level: logLevel });
  });
  return { logs, logger };
};

const flatMessages = (logs: ReadonlyArray<HostLog>): ReadonlyArray<string> =>
  logs.flatMap(({ message }) => (Array.isArray(message) ? message.map(String) : [String(message)]));

describe("embedding-host observability", () => {
  test("Lando spans from runtime.run and app handles parent to the host span", async () => {
    const { spans, tracer } = makeHostTracer();
    await withTempApp((cwd) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const runtime = yield* openLandoRuntime({ cwd, plugins });
          yield* Effect.gen(function* () {
            yield* runtime.run(Effect.void);
            const app = yield* runtime.app();
            yield* app.info();
          }).pipe(Effect.withSpan("host.request"));
        }).pipe(
          Effect.scoped,
          Effect.provideService(Tracer.Tracer, tracer),
          Effect.provideService(References.TracerEnabled, true),
        ),
      ),
    );

    const host = spans.find((span) => span.name === "host.request");
    expect(host).toBeDefined();
    for (const name of ["LandoRuntime.run", "LandoRuntime.app", "App.info"]) {
      const span = spans.find((candidate) => candidate.name === name);
      expect(span?.traceId).toBe(host?.traceId ?? "missing-host-span");
      expect(span === undefined ? [] : ancestorNames(span)).toContain("host.request");
    }
  });

  test("openLandoRuntime keeps host loggers and minimum level over an explicit Lando logLevel", async () => {
    const { logs, logger } = makeHostLogger();
    const observed = await withTempApp((cwd) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const runtime = yield* openLandoRuntime({ cwd, plugins, logLevel: "error" });
          return yield* runtime.run(
            Effect.gen(function* () {
              yield* Effect.logDebug("host-debug-line");
              const lando = yield* LandoLogger;
              yield* lando.info("lando-sdk-line");
              return {
                level: yield* References.MinimumLogLevel,
                loggers: yield* References.CurrentLoggers,
              };
            }),
          );
        }).pipe(
          Effect.scoped,
          Effect.provideService(References.CurrentLoggers, new Set([logger])),
          Effect.provideService(References.MinimumLogLevel, "Debug"),
        ),
      ),
    );

    expect(observed.level).toBe("Debug");
    expect([...observed.loggers]).toEqual([logger]);
    expect(flatMessages(logs)).toEqual(expect.arrayContaining(["host-debug-line", "lando-sdk-line"]));
  });

  test("without host references the library default stays silent", async () => {
    const loggers = await withTempApp((cwd) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const runtime = yield* openLandoRuntime({ cwd, plugins });
          return yield* runtime.run(
            Effect.gen(function* () {
              const app = yield* runtime.app();
              yield* app.info();
              return yield* References.CurrentLoggers;
            }),
          );
        }).pipe(Effect.scoped),
      ),
    );

    expect(loggers.size).toBe(0);
  });

  test("makeLandoRuntime provided directly keeps the host logger and level", async () => {
    const { logs, logger } = makeHostLogger();
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logDebug("direct-layer-line");
        return { level: yield* References.MinimumLogLevel, loggers: yield* References.CurrentLoggers };
      }).pipe(
        Effect.provide(makeLandoRuntime({ bootstrap: "minimal", logLevel: "error" })),
        Effect.scoped,
        Effect.provideService(References.CurrentLoggers, new Set([logger])),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      ),
    );

    expect(observed.level).toBe("Debug");
    expect([...observed.loggers]).toEqual([logger]);
    expect(flatMessages(logs)).toContain("direct-layer-line");
  });

  test("makeLandoRuntime provided directly without host references stays silent", async () => {
    const loggers = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* References.CurrentLoggers;
      }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "minimal" })), Effect.scoped),
    );

    expect(loggers.size).toBe(0);
  });

  test("defects reach the host reporter exactly once; tagged failures do not", async () => {
    const reported: Array<Cause.Cause<unknown>> = [];
    const reporter = ErrorReporter.make(({ cause }) => {
      reported.push(cause);
    });
    const exits = await withTempApp((cwd) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const runtime = yield* openLandoRuntime({ cwd, plugins });
          const failure = yield* Effect.exit(runtime.run(Effect.fail(new HostVisibleFailure())));
          const failuresReported = reported.length;
          // Nested Lando boundaries (run -> run) must still report the defect once.
          const defect = yield* Effect.exit(runtime.run(runtime.run(Effect.die("lando-defect"))));
          return { failure, failuresReported, defect };
        }).pipe(Effect.scoped, Effect.provide(ErrorReporter.layer([reporter]))),
      ),
    );

    expect(exits.failure._tag).toBe("Failure");
    expect(exits.failuresReported).toBe(0);
    expect(exits.defect._tag).toBe("Failure");
    expect(reported).toHaveLength(1);
    expect(reported.every(Cause.hasDies)).toBe(true);
  });

  test("an app-handle defect reaches a raw host reporter once, even inside runtime.run", async () => {
    const reports: Array<Cause.Cause<unknown>> = [];
    const raw: ErrorReporter.ErrorReporter = {
      [ErrorReporter.TypeId]: ErrorReporter.TypeId,
      report: ({ cause }) => {
        reports.push(cause);
      },
    };
    const dyingProvider = { ...TestRuntimeProvider, inspect: () => Effect.die("provider-inspect-defect") };
    const dyingPlugins = {
      policy: "bundled-only",
      layers: [
        Layer.succeed(RuntimeProvider, RuntimeProvider.of(dyingProvider)),
        Layer.succeed(
          RuntimeProviderRegistry,
          RuntimeProviderRegistry.of({
            list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
            capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
            select: () => Effect.succeed(dyingProvider),
          }),
        ),
        Layer.succeed(RouterService, RouterService.of(TestRouterService)),
      ],
    } as const;
    const exits = await withTempApp((cwd) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const runtime = yield* openLandoRuntime({ cwd, plugins: dyingPlugins });
          const app = yield* runtime.app();
          const direct = yield* Effect.exit(app.info());
          const reportedDirect = reports.length;
          const nested = yield* Effect.exit(runtime.run(app.info()));
          return { direct, reportedDirect, nested };
        }).pipe(Effect.scoped, Effect.provideService(ErrorReporter.CurrentErrorReporters, new Set([raw]))),
      ),
    );

    expect(exits.direct._tag).toBe("Failure");
    expect(exits.reportedDirect).toBe(1);
    expect(exits.nested._tag).toBe("Failure");
    expect(reports).toHaveLength(2);
    expect(reports.every(Cause.hasDies)).toBe(true);
  });
});
