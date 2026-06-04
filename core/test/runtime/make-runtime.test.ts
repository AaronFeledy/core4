import { describe, expect, test } from "bun:test";

import { Cause, Context, Effect, Exit, Layer, Option } from "effect";

import { LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import {
  AppPlanner,
  CommandRegistry,
  ConfigService,
  FileSystem,
  LandofileService,
  Logger,
  RuntimeProvider,
  RuntimeProviderRegistry,
  SecretStore,
  ToolingEngine,
} from "@lando/sdk/services";

import { makeLandoRuntime } from "../../src/runtime/layer.ts";

describe("makeLandoRuntime", () => {
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

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(LandoRuntimeBootstrapError);
        if (failure.value instanceof LandoRuntimeBootstrapError) {
          expect(failure.value._tag).toBe("LandoRuntimeBootstrapError");
          expect(failure.value.stage).toBe("minimal");
        }
      }
    }
  });

  test("malformed options fail with a structured LandoRuntimeBootstrapError", async () => {
    const options: unknown = null;
    const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(makeLandoRuntime(options))));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(LandoRuntimeBootstrapError);
        if (failure.value instanceof LandoRuntimeBootstrapError) {
          expect(failure.value._tag).toBe("LandoRuntimeBootstrapError");
          expect(failure.value.stage).toBe("minimal");
        }
      }
    }
  });

  test("non-Layer entries in plugins.layers fail with LandoRuntimeBootstrapError", async () => {
    const options: unknown = {
      bootstrap: "app",
      plugins: { layers: ["not-a-layer"] },
    };
    const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(makeLandoRuntime(options))));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(LandoRuntimeBootstrapError);
        if (failure.value instanceof LandoRuntimeBootstrapError) {
          expect(failure.value.message).toContain("plugins.layers[0]");
          expect(failure.value.message).toContain("Effect Layer");
        }
      }
    }
  });
});
