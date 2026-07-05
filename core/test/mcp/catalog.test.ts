import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { McpToolInputError } from "@lando/sdk/errors";

import { EmptyResultSchema, type LandoCommandSpec } from "../../src/cli/oclif/command-base.ts";
import { buildCatalog, computeEffectiveAllowlist } from "../../src/mcp/catalog.ts";
import { type McpCommandEntry, deriveToolInputSchema, validateToolInput } from "../../src/mcp/registry.ts";

const spec = (id: string, extra: Partial<LandoCommandSpec> = {}): LandoCommandSpec => ({
  id,
  summary: `${id} summary`,
  namespace: id.split(":")[0] as LandoCommandSpec["namespace"],
  bootstrap: "app",
  resultSchema: EmptyResultSchema,
  run: () => Schema.encodeSync(EmptyResultSchema) as never,
  ...extra,
});

const entry = (id: string, extra: Partial<LandoCommandSpec> = {}): McpCommandEntry => ({
  spec: spec(id, extra),
});

describe("deriveToolInputSchema", () => {
  test("projects flags and args into a closed object schema", () => {
    const schema = deriveToolInputSchema(
      spec("app:info", {
        flags: { format: { type: "string", required: true, description: "Output format." } },
        args: { name: { type: "string" } },
      }),
    );
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        flags: {
          type: "object",
          additionalProperties: false,
          properties: { format: { type: "string", description: "Output format." } },
          required: ["format"],
        },
        args: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      },
    });
  });

  test("a command with no flags/args gets empty closed groups", () => {
    const schema = deriveToolInputSchema(spec("meta:version"));
    expect(schema).toMatchObject({
      properties: {
        flags: { type: "object", properties: {}, additionalProperties: false },
        args: { type: "object", properties: {}, additionalProperties: false },
      },
    });
    expect((schema.properties as Record<string, { required?: string[] }>).flags.required).toBeUndefined();
  });
});

describe("validateToolInput", () => {
  const withFlags = spec("app:logs", {
    flags: { format: { type: "string", required: true }, tail: { type: "number" } },
    args: { service: { type: "string" } },
  });

  test("rejects a missing required flag with the flag path", () => {
    try {
      validateToolInput(withFlags, { flags: {} });
      throw new Error("expected McpToolInputError");
    } catch (error) {
      expect(error).toBeInstanceOf(McpToolInputError);
      expect((error as McpToolInputError).path).toBe("flags.format");
    }
  });

  test("rejects an unknown flag with its path", () => {
    try {
      validateToolInput(withFlags, { flags: { format: "json", nope: true } });
      throw new Error("expected McpToolInputError");
    } catch (error) {
      expect((error as McpToolInputError).path).toBe("flags.nope");
    }
  });

  test("rejects a wrong-typed arg with its path", () => {
    try {
      validateToolInput(withFlags, { flags: { format: "json" }, args: { service: 12 } });
      throw new Error("expected McpToolInputError");
    } catch (error) {
      expect((error as McpToolInputError).path).toBe("args.service");
    }
  });

  test("accepts a valid input and returns normalized flags/args", () => {
    expect(validateToolInput(withFlags, { flags: { format: "json", tail: 10 } })).toEqual({
      flags: { format: "json", tail: 10 },
      args: {},
    });
  });
});

describe("computeEffectiveAllowlist", () => {
  test("unions defaults with allow", () => {
    const result = computeEffectiveAllowlist({ defaults: ["app:info"], allow: ["app:destroy"] });
    expect([...result.ids].sort()).toEqual(["app:destroy", "app:info"]);
    expect(result.source).toContain("allow");
  });

  test("deny wins over allow and defaults", () => {
    const result = computeEffectiveAllowlist({
      defaults: ["app:info", "app:logs"],
      allow: ["app:exec"],
      deny: ["app:exec", "app:logs"],
    });
    expect([...result.ids]).toEqual(["app:info"]);
    expect(result.source).toContain("deny");
  });
});

describe("buildCatalog", () => {
  const commandEntries = [entry("app:info"), entry("app:logs"), entry("meta:version")];

  test("emits one sorted tool per effective-allowlist command", () => {
    const catalog = buildCatalog({
      commandEntries,
      effective: computeEffectiveAllowlist({ defaults: ["meta:version", "app:info"] }),
    });
    expect(catalog.tools.map((tool) => tool.toolId)).toEqual(["app:info", "meta:version"]);
    expect(catalog.tools[0]).toMatchObject({
      toolId: "app:info",
      commandId: "app:info",
      title: "app:info summary",
      destructive: false,
    });
  });

  test("marks an explicitly-allowed destructive id as destructive", () => {
    const catalog = buildCatalog({
      commandEntries: [entry("app:destroy")],
      effective: computeEffectiveAllowlist({ defaults: [], allow: ["app:destroy"] }),
    });
    expect(catalog.tools[0]).toMatchObject({ toolId: "app:destroy", destructive: true });
  });

  test("projects tooling entries only when tooling is requested", () => {
    const base = {
      commandEntries,
      toolingEntries: [entry("app:php")],
      effective: computeEffectiveAllowlist({ defaults: ["app:info"] }),
    };
    expect(buildCatalog(base).tools.map((t) => t.toolId)).toEqual(["app:info"]);
    expect(buildCatalog({ ...base, options: { tooling: true } }).tools.map((t) => t.toolId)).toEqual([
      "app:info",
      "app:php",
    ]);
  });
});
