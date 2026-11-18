import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { installSignalHandlers } from "@lando/engine/runtime/interrupt";
import { normalizePluginPolicy } from "@lando/engine/runtime/runtime-options";
import { LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import {
  AppPlanner,
  CacheService,
  CommandRegistry,
  ConfigService,
  FileSystem,
  InteractionService,
  LandofileService,
  Logger,
  PluginRegistry,
  Renderer,
  RuntimeProvider,
  RuntimeProviderRegistry,
  SecretStore,
  Telemetry,
  ToolingEngine,
} from "@lando/sdk/services";
import { Cause, Context, Effect, Exit, Layer, Option, Result, Schema } from "effect";
import { LandoRuntimeOptions, makeLandoRuntime } from "../../src/runtime/layer.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const runtimeSignals = ["SIGINT", "SIGTERM"] as const;

const addedListeners = (signal: NodeJS.Signals, before: readonly NodeJS.SignalsListener[]) =>
  process.listeners(signal).filter((handler) => !before.includes(handler));

const captureConsoleLog = async (run: () => Promise<void>): Promise<ReadonlyArray<string>> => {
  const lines: Array<string> = [];
  const previousLog = console.log;
  try {
    console.log = (...args: ReadonlyArray<unknown>) => {
      lines.push(args.map(String).join(" "));
    };
    await run();
    return lines;
  } finally {
    console.log = previousLog;
  }
};

const expectRuntimeBootstrapError = (exit: Exit.Exit<unknown, unknown>): LandoRuntimeBootstrapError => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");

  const failure = Cause.findErrorOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected tagged failure");

  expect(failure.value).toBeInstanceOf(LandoRuntimeBootstrapError);
  if (!(failure.value instanceof LandoRuntimeBootstrapError)) {
    throw new Error("expected LandoRuntimeBootstrapError");
  }
  return failure.value;
};

describe("makeLandoRuntime", () => {
  test("normalizes complete source discovery and external import policy", () => {
    // Given
    const manifest = Schema.decodeSync(PluginManifest)({
      name: "@example/explicit",
      version: "1.0.0",
      api: 4,
    });
    const entry = definePlugin({ name: manifest.name, manifest });

    // When
    const policy = normalizePluginPolicy({
      manifests: [{ manifest, entry }],
      discovery: { bundled: false, system: true, user: false, app: true },
    });

    // Then
    expect(policy.manifests).toEqual([{ manifest, entry }]);
    expect(policy.discovery).toEqual({
      bundled: false,
      system: true,
      user: false,
      app: true,
      disable: [],
    });
    expect(policy.externalImports).toBe(true);
  });

  test("applies library-mode defaults at runtime construction", async () => {
    const context = await Effect.runPromise(
      Effect.scoped(Layer.build(makeLandoRuntime({ bootstrap: "tooling" }))),
    );
    const registry = Context.get(context, PluginRegistry);
    const renderer = Context.get(context, Renderer);
    const telemetry = Context.get(context, Telemetry);

    expect(renderer.id).toBe("json");
    expect(telemetry.enabled).toBe(false);
    await expect(Effect.runPromise(registry.list)).resolves.toEqual([]);
  });

  test("honors explicit library-mode default overrides", async () => {
    const context = await Effect.runPromise(
      Effect.scoped(
        Layer.build(
          makeLandoRuntime({
            bootstrap: "tooling",
            renderer: "plain",
            telemetry: true,
            plugins: { policy: "bundled-only" },
          }),
        ),
      ),
    );
    const registry = Context.get(context, PluginRegistry);
    const renderer = Context.get(context, Renderer);
    const telemetry = Context.get(context, Telemetry);

    expect(renderer.id).toBe("plain");
    expect(telemetry.enabled).toBe(true);
    await expect(Effect.runPromise(registry.load("@lando/provider-lando"))).resolves.toMatchObject({
      name: "@lando/provider-lando",
    });
  });

  test("applies the silent logger by default (no log output)", async () => {
    const lines = await captureConsoleLog(() =>
      Effect.runPromise(
        Effect.flatMap(Logger, (logger) => logger.info("library default should be silent")).pipe(
          Effect.provide(makeLandoRuntime({ bootstrap: "minimal" })),
        ),
      ),
    );

    expect(lines).toEqual([]);
  });

  test("honors the explicit logger override (pretty emits output)", async () => {
    const lines = await captureConsoleLog(() =>
      Effect.runPromise(
        Effect.flatMap(Logger, (logger) => logger.info("override visible info")).pipe(
          Effect.provide(makeLandoRuntime({ bootstrap: "minimal", logger: "pretty" })),
        ),
      ),
    );

    expect(lines.some((line) => line.includes("INFO") && line.includes("override visible info"))).toBe(true);
  });

  test("defaults library plugin policy to explicit discovery-free registry", async () => {
    const context = await Effect.runPromise(
      Effect.scoped(Layer.build(makeLandoRuntime({ bootstrap: "tooling" }))),
    );
    const registry = Context.get(context, PluginRegistry);

    await expect(Effect.runPromise(registry.list)).resolves.toEqual([]);
  });

  test("does not install process signal handlers by default", async () => {
    const snapshots = runtimeSignals.map((signal) => ({ signal, before: process.listeners(signal) }));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(makeLandoRuntime({ bootstrap: "minimal" }));
          for (const { signal, before } of snapshots) expect(addedListeners(signal, before)).toEqual([]);
        }),
      ),
    );
  });

  test("installs and removes process signal handlers when explicitly requested", async () => {
    const snapshots = runtimeSignals.map((signal) => ({ signal, before: process.listeners(signal) }));

    const installed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(makeLandoRuntime({ bootstrap: "minimal", installSignalHandlers: true }));
          return snapshots.map(({ signal, before }) => {
            const handlers = addedListeners(signal, before);
            expect(handlers).toHaveLength(1);
            return { signal, handlers };
          });
        }),
      ),
    );

    for (const { signal, handlers } of installed) {
      for (const handler of handlers) expect(process.listeners(signal)).not.toContain(handler);
    }
  });

  test("installed signal handlers interrupt the running fiber", async () => {
    const signal = "SIGTERM";
    const before = process.listeners(signal);
    let installed: readonly NodeJS.SignalsListener[] = [];
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.withFiber((fiber) => installSignalHandlers({ fiber, signals: [signal] }));
          installed = addedListeners(signal, before);
          expect(installed).toHaveLength(1);
          for (const handler of installed) handler(signal);
          yield* Effect.never;
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected signal interruption");
    expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    for (const handler of installed) expect(process.listeners(signal)).not.toContain(handler);
  });

  test("makeLandoRuntime signal handlers interrupt the provided program", () => {
    const script = `
      import { strict as assert } from "node:assert";
      import { Cause, Effect, Exit } from "effect";
      import { makeLandoRuntime } from "@lando/core";

      const before = process.listeners("SIGINT");
      let installed = [];
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          installed = process.listeners("SIGINT").filter((handler) => !before.includes(handler));
          process.emit("SIGINT");
          yield* Effect.never;
        }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "minimal", installSignalHandlers: true }))),
      );

      assert.equal(installed.length, 1);
      assert.equal(Exit.isFailure(exit), true);
      if (!Exit.isFailure(exit)) throw new Error("expected signal interruption");
      assert.equal(Cause.hasInterruptsOnly(exit.cause), true);
      assert.equal(process.listeners("SIGINT").includes(installed[0]), false);
      console.log("signal-ok");
    `;
    const proc = Bun.spawnSync([process.execPath, "--eval", script], {
      cwd: repoRoot,
      env: { ...process.env, PWD: repoRoot },
      stderr: "pipe",
      stdout: "pipe",
      timeout: 10_000,
    });

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("signal-ok");
  });

  test("repeated runtime construction keeps mutable service state isolated", async () => {
    const writeAndRead = Effect.gen(function* () {
      const cache = yield* CacheService;
      yield* cache.write("runtime-isolation", "first");
      return yield* cache.read("runtime-isolation", Schema.String);
    });
    const readOnly = Effect.gen(function* () {
      const cache = yield* CacheService;
      return yield* cache.read("runtime-isolation", Schema.String);
    });

    await expect(
      Effect.runPromise(writeAndRead.pipe(Effect.provide(makeLandoRuntime({ bootstrap: "minimal" })))),
    ).resolves.toBe("first");
    await expect(
      Effect.runPromise(readOnly.pipe(Effect.provide(makeLandoRuntime({ bootstrap: "minimal" })))),
    ).resolves.toBeNull();
  });

  test("the returned runtime layer finalizes scoped resources when the scope closes", async () => {
    let finalized = false;
    const scopedResource = Layer.effectDiscard(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          finalized = true;
        }),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Layer.build(makeLandoRuntime({ bootstrap: "minimal", plugins: { layers: [scopedResource] } })),
      ),
    );

    expect(finalized).toBe(true);
  });

  test("honors bundled-only plugin policy", async () => {
    const context = await Effect.runPromise(
      Effect.scoped(
        Layer.build(makeLandoRuntime({ bootstrap: "tooling", plugins: { policy: "bundled-only" } })),
      ),
    );
    const registry = Context.get(context, PluginRegistry);

    await expect(Effect.runPromise(registry.load("@lando/provider-lando"))).resolves.toMatchObject({
      name: "@lando/provider-lando",
    });
  });

  test("honors none plugin policy", async () => {
    const context = await Effect.runPromise(
      Effect.scoped(Layer.build(makeLandoRuntime({ bootstrap: "tooling", plugins: { policy: "none" } }))),
    );
    const registry = Context.get(context, PluginRegistry);

    await expect(Effect.runPromise(registry.list)).resolves.toEqual([]);
  });

  test("minimal bootstrap satisfies logger, config, and filesystem only", async () => {
    const runtime = makeLandoRuntime({ bootstrap: "minimal" });
    const context = await Effect.runPromise(Effect.scoped(Layer.build(runtime)));

    expect(Option.isSome(Context.getOption(context, Logger))).toBe(true);
    expect(Option.isSome(Context.getOption(context, ConfigService))).toBe(true);
    expect(Option.isSome(Context.getOption(context, FileSystem))).toBe(true);
    expect(Option.isSome(Context.getOption(context, SecretStore))).toBe(true);
    expect(Option.isNone(Context.getOption(context, RuntimeProvider))).toBe(true);
  });

  test("provider bootstrap satisfies runtime provider and registry", async () => {
    const context = await Effect.runPromise(
      Effect.scoped(Layer.build(makeLandoRuntime({ bootstrap: "provider" }))),
    );

    expect(Option.isSome(Context.getOption(context, RuntimeProvider))).toBe(true);
    expect(Option.isSome(Context.getOption(context, RuntimeProviderRegistry))).toBe(true);
  });

  test("tooling bootstrap satisfies command dispatch services without provider or app planning", async () => {
    const context = await Effect.runPromise(
      Effect.scoped(Layer.build(makeLandoRuntime({ bootstrap: "tooling" }))),
    );

    expect(Option.isSome(Context.getOption(context, LandofileService))).toBe(true);
    expect(Option.isSome(Context.getOption(context, CommandRegistry))).toBe(true);
    expect(Option.isSome(Context.getOption(context, PluginRegistry))).toBe(true);
    expect(Option.isNone(Context.getOption(context, RuntimeProvider))).toBe(true);
    expect(Option.isNone(Context.getOption(context, RuntimeProviderRegistry))).toBe(true);
    expect(Option.isNone(Context.getOption(context, AppPlanner))).toBe(true);
    expect(Option.isNone(Context.getOption(context, ToolingEngine))).toBe(true);
  });

  test("app bootstrap satisfies landofile, app planner, and runtime provider", async () => {
    const context = await Effect.runPromise(
      Effect.scoped(Layer.build(makeLandoRuntime({ bootstrap: "app" }))),
    );

    expect(Option.isSome(Context.getOption(context, LandofileService))).toBe(true);
    expect(Option.isSome(Context.getOption(context, AppPlanner))).toBe(true);
    expect(Option.isSome(Context.getOption(context, RuntimeProvider))).toBe(true);
  });

  test("invalid bootstrap fails with a structured LandoRuntimeBootstrapError", async () => {
    const options: unknown = { bootstrap: "bad-level" };
    const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(makeLandoRuntime(options))));

    const error = expectRuntimeBootstrapError(exit);
    expect(error._tag).toBe("LandoRuntimeBootstrapError");
    expect(error.stage).toBe("minimal");
  });

  test("malformed options fail with a structured LandoRuntimeBootstrapError", async () => {
    const options: unknown = null;
    const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(makeLandoRuntime(options))));

    const error = expectRuntimeBootstrapError(exit);
    expect(error._tag).toBe("LandoRuntimeBootstrapError");
    expect(error.stage).toBe("minimal");
  });

  test("non-Layer entries in plugins.layers fail with LandoRuntimeBootstrapError", async () => {
    const options: unknown = {
      bootstrap: "app",
      plugins: { layers: ["not-a-layer"] },
    };
    const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(makeLandoRuntime(options))));

    const error = expectRuntimeBootstrapError(exit);
    expect(error.message).toContain("plugins.layers[0]");
    expect(error.message).toContain("Effect Layer");
  });

  test("accepts and preserves the interaction mode option", () => {
    const decoded = Schema.decodeUnknownResult(LandoRuntimeOptions)({
      bootstrap: "minimal",
      interaction: "non-interactive",
    });
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) expect(decoded.success.interaction).toBe("non-interactive");
  });

  test("rejects an invalid interaction mode", () => {
    const decoded = Schema.decodeUnknownResult(LandoRuntimeOptions)({
      bootstrap: "minimal",
      interaction: "loud",
    });
    expect(Result.isFailure(decoded)).toBe(true);
  });

  test("the interaction mode flows to the constructed InteractionService default", async () => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            makeLandoRuntime({ bootstrap: "minimal", interaction: "non-interactive" }),
          );
          const interaction = Context.get(context, InteractionService);
          return yield* Effect.exit(
            Effect.scoped(interaction.promptAll([{ name: "app", type: "text", message: "Name?" }])),
          );
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Cause.findErrorOption((exit as Exit.Failure<unknown, unknown>).cause);
    expect(Option.isSome(failure) ? (failure.value as { _tag?: string })._tag : undefined).toBe(
      "InteractionRequiredError",
    );
  });

  test("honors an explicit interaction mode override", async () => {
    const answers = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            makeLandoRuntime({ bootstrap: "minimal", interaction: "non-interactive" }),
          );
          const interaction = Context.get(context, InteractionService);
          return yield* Effect.scoped(
            interaction.promptAll([{ name: "app", type: "text", message: "Name?", default: "fallback" }], {
              yes: true,
            }),
          );
        }),
      ),
    );
    expect(answers).toEqual({ app: "fallback" });
  });

  test("a host InteractionService override in plugins.layers wins", async () => {
    const hostService = InteractionService.of({
      id: "host-interaction",
      isInteractive: Effect.succeed(false),
      prompt: () => Effect.succeed("host" as never),
      promptAll: () => Effect.succeed({ app: "host" } as never),
      confirm: () => Effect.succeed(true),
      select: () => Effect.succeed("host" as never),
      secret: () => Effect.succeed("host" as never),
    });
    const context = await Effect.runPromise(
      Effect.scoped(
        Layer.build(
          makeLandoRuntime({
            bootstrap: "minimal",
            plugins: { layers: [Layer.succeed(InteractionService, hostService)] },
          }),
        ),
      ),
    );
    const interaction = Context.get(context, InteractionService);
    expect(interaction.id).toBe("host-interaction");
  });
});
