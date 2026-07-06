import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";

import type { GlobalConfig, McpConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

import {
  type McpCommandRegistry,
  mcpFlagsFromParsed,
  mcpListResult,
  mcpRegistryFromCompiled,
  mcpRegistryWithToolingEntries,
  resolveMcpOptions,
  validateMcpAllowlistIds,
} from "../../../../src/cli/commands/meta/mcp.ts";
import type { McpCommandEntry } from "../../../../src/mcp/registry.ts";

const entry = (id: string, summary: string): McpCommandEntry => ({
  spec: { id, summary } as McpCommandEntry["spec"],
});

const configLayer = (mcp: McpConfig | undefined) =>
  Layer.succeed(ConfigService, {
    load: Effect.succeed({} as GlobalConfig),
    get: (key) => Effect.succeed((key === "mcp" ? mcp : undefined) as never),
  });

// app:info is in the generated default allowlist; app:config is not.
const registry: McpCommandRegistry = {
  commandEntries: [entry("app:info", "Show app info"), entry("app:config", "App config")],
};

describe("resolveMcpOptions", () => {
  test("unions flag + config allow/deny and ORs tooling", () => {
    const options = resolveMcpOptions(
      { allow: ["app:logs"], tooling: false },
      { allow: ["app:info"], deny: ["meta:doctor"], tooling: true },
    );
    expect(options.allow).toEqual(["app:info", "app:logs"]);
    expect(options.deny).toEqual(["meta:doctor"]);
    expect(options.tooling).toBe(true);
  });

  test("treats undefined config as empty", () => {
    const options = resolveMcpOptions({ allow: ["app:info"] }, undefined);
    expect(options.allow).toEqual(["app:info"]);
    expect(options.deny).toEqual([]);
    expect(options.tooling).toBe(false);
  });
});

describe("validateMcpAllowlistIds", () => {
  const known = new Set(["app:info", "app:logs"]);

  test("passes when every id is known", () =>
    Effect.runPromise(
      validateMcpAllowlistIds({ allow: ["app:info"], deny: ["app:logs"], tooling: false }, known),
    ));

  test("ignores unknown deny ids because deny is only subtractive", () =>
    Effect.runPromise(
      validateMcpAllowlistIds({ allow: ["app:info"], deny: ["tooling:disabled"], tooling: false }, known),
    ));

  test("rejects an unknown --allow id with McpToolInputError carrying the flag path", async () => {
    const exit = await Effect.runPromiseExit(
      validateMcpAllowlistIds({ allow: ["does:not:exist"], deny: [], tooling: false }, known),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("McpToolInputError");
      expect(exit.cause.error.path).toBe("flags.allow");
      expect(exit.cause.error.toolId).toBe("does:not:exist");
    }
  });
});

describe("mcpFlagsFromParsed", () => {
  test("normalizes repeatable flags and booleans from parsed OCLIF output", () => {
    expect(
      mcpFlagsFromParsed({
        allow: ["app:info", 12, "app:logs"],
        deny: [],
        tooling: true,
        list: false,
      }),
    ).toEqual({ allow: ["app:info", "app:logs"], tooling: true, list: false });
  });
});

describe("mcpRegistryFromCompiled", () => {
  test("projects only compiled commands with Lando specs", () => {
    const spec = entry("app:info", "Show app info").spec;
    const registry = mcpRegistryFromCompiled({
      "app:info": { landoSpec: spec },
      "meta:missing": {},
    });

    expect(registry).toEqual({ commandEntries: [{ spec }] });
  });
});

describe("mcpRegistryWithToolingEntries", () => {
  test("projects visible registered tooling commands into MCP tooling entries", () => {
    const base = { commandEntries: [entry("app:info", "Show app info")] };
    const registry = mcpRegistryWithToolingEntries(base, [
      { id: "app:composer", summary: "Run Composer", hidden: false },
      { id: "app:hidden", summary: "Hidden", hidden: true },
    ]);

    expect(registry.commandEntries).toEqual(base.commandEntries);
    expect(registry.toolingEntries?.map((tooling) => tooling.spec.id)).toEqual(["app:composer"]);
    expect(registry.toolingEntries?.[0]?.tooling).toBe(true);
  });
});

describe("mcpListResult", () => {
  test("projects the effective catalog with per-tool source of allowance", async () => {
    const result = await Effect.runPromise(
      mcpListResult(registry, { allow: ["app:config"] }).pipe(Effect.provide(configLayer(undefined))),
    );
    expect(result.tools).toEqual([
      { id: "app:config", summary: "App config", source: "allow" },
      { id: "app:info", summary: "Show app info", source: "default" },
    ]);
  });

  test("deny (global config) removes an id from the effective list", async () => {
    const result = await Effect.runPromise(
      mcpListResult(registry, { allow: ["app:config"] }).pipe(
        Effect.provide(configLayer({ deny: ["app:info"] })),
      ),
    );
    expect(result.tools.map((tool) => tool.id)).toEqual(["app:config"]);
  });

  test("global config tooling exposes registered tooling entries in the list result", async () => {
    const result = await Effect.runPromise(
      mcpListResult(
        mcpRegistryWithToolingEntries(registry, [
          { id: "app:composer", summary: "Run Composer", hidden: false },
        ]),
        {},
      ).pipe(Effect.provide(configLayer({ tooling: true }))),
    );

    expect(result.tools).toContainEqual({ id: "app:composer", summary: "Run Composer", source: "tooling" });
  });

  test("fails with McpToolInputError when an unknown id is requested", async () => {
    const exit = await Effect.runPromiseExit(
      mcpListResult(registry, { allow: ["bogus:id"] }).pipe(Effect.provide(configLayer(undefined))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
