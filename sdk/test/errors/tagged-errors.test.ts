import { describe, expect, test } from "bun:test";

import { Cause, Effect, Exit } from "effect";

import {
  LandoRuntimeBootstrapError,
  LandofileParseError,
  NoProviderInstalledError,
  PluginLoadError,
  ProviderCapabilityError,
} from "@lando/sdk/errors";

describe("LandofileParseError", () => {
  test("carries the spec-mandated payload fields", () => {
    const fields = Object.keys(LandofileParseError.fields);
    expect(fields).toContain("filePath");
    expect(fields).toContain("message");
    expect(fields).toContain("line");
    expect(fields).toContain("column");
  });

  test("constructs without line or column (both optional)", () => {
    const error = new LandofileParseError({
      filePath: "/tmp/.lando.yml",
      message: "unexpected token",
    });
    expect(error._tag).toBe("LandofileParseError");
    expect(error.filePath).toBe("/tmp/.lando.yml");
    expect(error.message).toBe("unexpected token");
    expect(error.line).toBeUndefined();
    expect(error.column).toBeUndefined();
  });

  test("constructs with a structured payload (line/column populated)", () => {
    const error = new LandofileParseError({
      filePath: "/tmp/.lando.yml",
      message: "expected mapping value",
      line: 7,
      column: 12,
    });
    expect(error._tag).toBe("LandofileParseError");
    expect(error.filePath).toBe("/tmp/.lando.yml");
    expect(error.line).toBe(7);
    expect(error.column).toBe(12);
  });

  test("survives Effect.fail then Effect.runPromiseExit with _tag intact", async () => {
    const error = new LandofileParseError({
      filePath: "/app/.lando.yml",
      message: "unexpected token",
      line: 3,
      column: 1,
    });
    const exit = await Effect.runPromiseExit(Effect.fail(error));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value._tag).toBe("LandofileParseError");
        expect(failure.value).toBeInstanceOf(LandofileParseError);
      }
    }
  });
});

describe("ProviderCapabilityError", () => {
  test("carries the spec-mandated payload fields", () => {
    const fields = Object.keys(ProviderCapabilityError.fields);
    expect(fields).toContain("providerId");
    expect(fields).toContain("capability");
    expect(fields).toContain("requiredValue");
    expect(fields).toContain("actualValue");
  });

  test("constructs with the spec-mandated payload (boolean-shaped capability)", () => {
    const error = new ProviderCapabilityError({
      providerId: "provider-docker",
      operation: "checkCapability",
      message: "provider does not support copy-on-write app root",
      capability: "copyOnWriteAppRoot",
      requiredValue: true,
      actualValue: false,
    });
    expect(error._tag).toBe("ProviderCapabilityError");
    expect(error.providerId).toBe("provider-docker");
    expect(error.capability).toBe("copyOnWriteAppRoot");
    expect(error.requiredValue).toBe(true);
    expect(error.actualValue).toBe(false);
  });

  test("constructs with literal-valued required/actualValue (e.g. bindMountPerformance)", () => {
    const error = new ProviderCapabilityError({
      providerId: "provider-docker",
      operation: "checkCapability",
      message: "bind mount performance below required threshold",
      capability: "bindMountPerformance",
      requiredValue: "native",
      actualValue: "slow",
    });
    expect(error._tag).toBe("ProviderCapabilityError");
    expect(error.requiredValue).toBe("native");
    expect(error.actualValue).toBe("slow");
  });

  test("survives Effect.fail then Effect.runPromiseExit with _tag intact", async () => {
    const error = new ProviderCapabilityError({
      providerId: "provider-docker",
      operation: "checkCapability",
      message: "missing capability",
      capability: "sharedCrossAppNetwork",
      requiredValue: true,
      actualValue: false,
    });
    const exit = await Effect.runPromiseExit(Effect.fail(error));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value._tag).toBe("ProviderCapabilityError");
        expect(failure.value).toBeInstanceOf(ProviderCapabilityError);
      }
    }
  });
});

describe("LandoRuntimeBootstrapError", () => {
  test("carries the payload fields needed to render which bootstrap stage failed", () => {
    const fields = Object.keys(LandoRuntimeBootstrapError.fields);
    expect(fields).toContain("message");
    expect(fields).toContain("stage");
  });

  test("constructs with stage and message", () => {
    const error = new LandoRuntimeBootstrapError({
      message: "plugin discovery failed",
      stage: "plugins",
    });
    expect(error._tag).toBe("LandoRuntimeBootstrapError");
    expect(error.message).toBe("plugin discovery failed");
    expect(error.stage).toBe("plugins");
  });

  test("preserves an optional cause", () => {
    const cause = new Error("filesystem unreadable");
    const error = new LandoRuntimeBootstrapError({
      message: "could not enumerate plugin dirs",
      stage: "plugins",
      cause,
    });
    expect(error.cause).toBe(cause);
  });

  test("survives Effect.fail then Effect.runPromiseExit with _tag intact", async () => {
    const error = new LandoRuntimeBootstrapError({
      message: "provider boot failed",
      stage: "provider",
    });
    const exit = await Effect.runPromiseExit(Effect.fail(error));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value._tag).toBe("LandoRuntimeBootstrapError");
        expect(failure.value).toBeInstanceOf(LandoRuntimeBootstrapError);
      }
    }
  });
});

describe("PluginLoadError", () => {
  test("carries the payload fields needed to identify the failing plugin", () => {
    const fields = Object.keys(PluginLoadError.fields);
    expect(fields).toContain("message");
    expect(fields).toContain("pluginName");
  });

  test("constructs with pluginName and message and preserves the optional cause", () => {
    const cause = new Error("module not found");
    const error = new PluginLoadError({
      message: "plugin entry threw on load",
      pluginName: "@lando/php",
      cause,
    });
    expect(error._tag).toBe("PluginLoadError");
    expect(error.pluginName).toBe("@lando/php");
    expect(error.message).toBe("plugin entry threw on load");
    expect(error.cause).toBe(cause);
  });

  test("survives Effect.fail then Effect.runPromiseExit with _tag intact", async () => {
    const error = new PluginLoadError({
      message: "boom",
      pluginName: "@lando/php",
    });
    const exit = await Effect.runPromiseExit(Effect.fail(error));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value._tag).toBe("PluginLoadError");
        expect(failure.value).toBeInstanceOf(PluginLoadError);
      }
    }
  });
});

describe("NoProviderInstalledError", () => {
  test("carries the payload fields needed to render a remediation hint", () => {
    const fields = Object.keys(NoProviderInstalledError.fields);
    expect(fields).toContain("message");
    expect(fields).toContain("suggestion");
  });

  test("constructs with message and an optional suggestion", () => {
    const error = new NoProviderInstalledError({
      message: "no runtime provider installed",
      suggestion: "run `lando setup` to install the bundled provider",
    });
    expect(error._tag).toBe("NoProviderInstalledError");
    expect(error.message).toBe("no runtime provider installed");
    expect(error.suggestion).toBe("run `lando setup` to install the bundled provider");
  });

  test("constructs without a suggestion (suggestion is optional)", () => {
    const error = new NoProviderInstalledError({
      message: "no runtime provider installed",
    });
    expect(error._tag).toBe("NoProviderInstalledError");
    expect(error.suggestion).toBeUndefined();
  });

  test("survives Effect.fail then Effect.runPromiseExit with _tag intact", async () => {
    const error = new NoProviderInstalledError({
      message: "no runtime provider installed",
    });
    const exit = await Effect.runPromiseExit(Effect.fail(error));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value._tag).toBe("NoProviderInstalledError");
        expect(failure.value).toBeInstanceOf(NoProviderInstalledError);
      }
    }
  });
});

describe("MVP tagged-error catalog", () => {
  test("the five MVP-mandated tagged-error classes are all exported", () => {
    expect(LandoRuntimeBootstrapError).toBeDefined();
    expect(ProviderCapabilityError).toBeDefined();
    expect(LandofileParseError).toBeDefined();
    expect(PluginLoadError).toBeDefined();
    expect(NoProviderInstalledError).toBeDefined();
  });

  test("each class exposes a stable _tag matching its own name", () => {
    expect(new LandoRuntimeBootstrapError({ message: "x", stage: "minimal" })._tag).toBe(
      "LandoRuntimeBootstrapError",
    );
    expect(
      new ProviderCapabilityError({
        providerId: "p",
        operation: "op",
        message: "x",
        capability: "c",
        requiredValue: true,
        actualValue: false,
      })._tag,
    ).toBe("ProviderCapabilityError");
    expect(new LandofileParseError({ filePath: "/x", message: "x" })._tag).toBe("LandofileParseError");
    expect(new PluginLoadError({ message: "x", pluginName: "p" })._tag).toBe("PluginLoadError");
    expect(new NoProviderInstalledError({ message: "x" })._tag).toBe("NoProviderInstalledError");
  });
});
