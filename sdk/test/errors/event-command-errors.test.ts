import { describe, expect, test } from "bun:test";

import { Either, Schema } from "effect";

import { CommandInputValidationError, ToolingCommandLookupError } from "@lando/sdk/errors";

describe("ToolingCommandLookupError", () => {
  test("is a tagged error with exact adjudicated fields", () => {
    const fields = Object.keys(ToolingCommandLookupError.fields);
    expect(fields).toContain("message");
    expect(fields).toContain("target");
    expect(fields).toContain("targetKind");
    expect(fields).toContain("remediation");
    expect(fields).toContain("pluginId");
    expect(fields).toContain("commandId");
    expect(fields).toContain("cause");

    const error = new ToolingCommandLookupError({
      message: 'Unknown canonical command "app:strt".',
      target: "app:strt",
      targetKind: "tooling",
      remediation: "Did you mean app:start?",
      pluginId: "example-plugin",
      commandId: "app:start",
      cause: new Error("lookup miss"),
    });

    expect(error._tag).toBe("ToolingCommandLookupError");
    expect(error.target).toBe("app:strt");
    expect(error.targetKind).toBe("tooling");
    expect(error.remediation).toContain("app:start");
    expect(error.pluginId).toBe("example-plugin");
    expect(error.commandId).toBe("app:start");
    expect(error.cause).toBeInstanceOf(Error);
  });

  test("accepts each targetKind variant and omittable optionals", () => {
    for (const targetKind of ["built-in", "plugin", "tooling"] as const) {
      const error = new ToolingCommandLookupError({
        message: `Unknown ${targetKind} target.`,
        target: "app:missing",
        targetKind,
        remediation: "Use a registered canonical id.",
      });
      expect(error.targetKind).toBe(targetKind);
      expect(error.pluginId).toBeUndefined();
      expect(error.commandId).toBeUndefined();
      expect(error.cause).toBeUndefined();
    }
  });

  test("decodes through schema preserving documented fields", () => {
    const decoded = Schema.decodeUnknownEither(ToolingCommandLookupError)({
      _tag: "ToolingCommandLookupError",
      message: "Unknown command.",
      target: "meta:plugin:ad",
      targetKind: "plugin",
      remediation: "Did you mean meta:plugin:add?",
      pluginId: "@lando/example",
    });

    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.target).toBe("meta:plugin:ad");
      expect(decoded.right.targetKind).toBe("plugin");
      expect(decoded.right.pluginId).toBe("@lando/example");
    }
  });
});

describe("CommandInputValidationError", () => {
  test("is a tagged error with exact adjudicated fields", () => {
    const fields = Object.keys(CommandInputValidationError.fields);
    expect(fields).toContain("message");
    expect(fields).toContain("target");
    expect(fields).toContain("field");
    expect(fields).toContain("kind");
    expect(fields).toContain("reason");
    expect(fields).toContain("remediation");
    expect(fields).toContain("cause");

    const error = new CommandInputValidationError({
      message: 'Unknown flag "rebuildx" for app:start.',
      target: "app:start",
      field: "rebuildx",
      kind: "flag",
      reason: "unknown",
      remediation: "Remove rebuildx or use a flag declared by app:start.",
      cause: new Error("schema mismatch"),
    });

    expect(error._tag).toBe("CommandInputValidationError");
    expect(error.target).toBe("app:start");
    expect(error.field).toBe("rebuildx");
    expect(error.kind).toBe("flag");
    expect(error.reason).toBe("unknown");
    expect(error.remediation).toContain("rebuildx");
    expect(error.cause).toBeInstanceOf(Error);
  });

  test("accepts flag and arg kinds and omittable cause", () => {
    const flagError = new CommandInputValidationError({
      message: "Missing required flag.",
      target: "app:start",
      field: "services",
      kind: "flag",
      reason: "required",
      remediation: "Provide services.",
    });
    const argError = new CommandInputValidationError({
      message: "Argument must be a string.",
      target: "meta:plugin:add",
      field: "name",
      kind: "arg",
      reason: "type",
      remediation: "Pass a string for name.",
    });

    expect(flagError.kind).toBe("flag");
    expect(flagError.cause).toBeUndefined();
    expect(argError.kind).toBe("arg");
    expect(argError.field).toBe("name");
  });

  test("decodes through schema preserving documented fields", () => {
    const decoded = Schema.decodeUnknownEither(CommandInputValidationError)({
      _tag: "CommandInputValidationError",
      message: "Invalid argument value.",
      target: "app:exec",
      field: "command",
      kind: "arg",
      reason: "type",
      remediation: "Pass a string for command.",
    });

    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.target).toBe("app:exec");
      expect(decoded.right.field).toBe("command");
      expect(decoded.right.kind).toBe("arg");
      expect(decoded.right.reason).toBe("type");
    }
  });
});
