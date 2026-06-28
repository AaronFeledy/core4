import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  CommandRegistrationError,
  EmptyResultSchema,
  type LandoCommandSpec,
  validateCommandSpec,
} from "../../src/cli/oclif/command-base.ts";
import compiledCommands from "../../src/cli/oclif/compiled-commands.ts";

const specFor = (commandClass: unknown): LandoCommandSpec | undefined =>
  (commandClass as { readonly landoSpec?: LandoCommandSpec }).landoSpec;

const canonicalIds = Object.keys(compiledCommands).sort();

describe("LandoCommandSpec.resultSchema registration contract", () => {
  test("every canonical command declares a resultSchema", () => {
    const missing = canonicalIds.filter((id) => {
      const spec = specFor((compiledCommands as Record<string, unknown>)[id]);
      return spec === undefined || spec.resultSchema === undefined || spec.resultSchema === null;
    });
    expect(missing).toEqual([]);
  });

  test("each declared resultSchema is an Effect Schema", () => {
    for (const id of canonicalIds) {
      const spec = specFor((compiledCommands as Record<string, unknown>)[id]);
      expect(Schema.isSchema(spec?.resultSchema)).toBe(true);
    }
  });

  test("validateCommandSpec rejects a spec missing resultSchema", () => {
    expect(() => validateCommandSpec({ id: "app:example" })).toThrow(CommandRegistrationError);
  });

  test("CommandRegistrationError carries the offending command id", () => {
    try {
      validateCommandSpec({ id: "app:example" });
      throw new Error("expected validateCommandSpec to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CommandRegistrationError);
      expect((error as CommandRegistrationError).commandId).toBe("app:example");
    }
  });

  test("validateCommandSpec accepts EmptyResultSchema and concrete schemas", () => {
    expect(() => validateCommandSpec({ id: "app:empty", resultSchema: EmptyResultSchema })).not.toThrow();
    expect(() =>
      validateCommandSpec({ id: "app:payload", resultSchema: Schema.Struct({ name: Schema.String }) }),
    ).not.toThrow();
  });

  test("EmptyResultSchema encodes a command with no payload to an empty object", () => {
    expect(Schema.encodeSync(EmptyResultSchema)({})).toEqual({});
  });
});
