import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";

import { McpToolInputError } from "@lando/sdk/errors";
import type { GlobalConfig, McpConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

import {
  type McpCommandRegistry,
  classifyMcpServeStartup,
  mcpFlagsFromParsed,
  mcpListResult,
  mcpRegistryFromCompiled,
  mcpRegistryWithToolingEntries,
  resolveMcpOptions,
  validateMcpAllowlistIds,
} from "../../../../src/cli/commands/meta/mcp.ts";
import type { LandoCommandSpec } from "../../../../src/cli/oclif/command-base.ts";
import compiledCommands from "../../../../src/cli/oclif/compiled-commands.ts";
import { APP_CONFIG_MCP_UNSAFE_IDS } from "../../../../src/cli/oclif/mcp-allowlist.ts";
import type { McpCommandEntry } from "../../../../src/mcp/registry.ts";

const entry = (id: string, summary: string): McpCommandEntry => ({
  spec: { id, summary } as McpCommandEntry["spec"],
});

const configLayer = (mcp: McpConfig | undefined) =>
  Layer.succeed(ConfigService, {
    load: Effect.succeed({} as GlobalConfig),
    get: (key) => Effect.succeed((key === "mcp" ? mcp : undefined) as never),
  });

const registry: McpCommandRegistry = {
  commandEntries: [entry("app:info", "Show app info"), entry("app:config:get", "App config")],
};

const appConfigUnsafeIds = [...APP_CONFIG_MCP_UNSAFE_IDS];

const fullRegistry = (): McpCommandRegistry =>
  mcpRegistryFromCompiled(compiledCommands as Record<string, { readonly landoSpec?: LandoCommandSpec }>);

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

  test("mcp-config-max-concurrent propagates a valid configured cap", () => {
    // Given
    const config = { tooling: false, maxConcurrent: 8 };

    // When
    const options = resolveMcpOptions({}, config);

    // Then
    expect(Reflect.get(options, "maxConcurrent")).toBe(8);
  });
});

describe("classifyMcpServeStartup", () => {
  const pipe = { available: true, tty: false, kind: "fifo" } as const;

  test("accepts only text serve mode with two usable non-TTY descriptors", () => {
    // Given / When
    const supported = classifyMcpServeStartup({ resultFormat: "text", stdin: pipe, stdout: pipe });
    const machine = classifyMcpServeStartup({ resultFormat: "json", stdin: pipe, stdout: pipe });
    const tty = classifyMcpServeStartup({
      resultFormat: "text",
      stdin: { available: true, tty: true, kind: "character" },
      stdout: pipe,
    });
    const missing = classifyMcpServeStartup({
      resultFormat: "text",
      stdin: pipe,
      stdout: { available: false, tty: false, kind: "other" },
    });

    // Then
    expect(supported).toBeUndefined();
    expect(machine?._tag).toBe("McpTransportError");
    expect(tty?._tag).toBe("McpTransportError");
    expect(missing?._tag).toBe("McpTransportError");
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
      expect(exit.cause.error).toBeInstanceOf(McpToolInputError);
      if (exit.cause.error instanceof McpToolInputError) {
        expect(exit.cause.error.path).toBe("flags.allow");
        expect(exit.cause.error.toolId).toBe("does:not:exist");
      }
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

  test("projects app config as constrained MCP read tools and omits the umbrella", () => {
    const registry = mcpRegistryFromCompiled({
      "app:config": { landoSpec: entry("app:config", "App config").spec },
    });

    expect(registry.commandEntries.map((command) => command.spec.id).sort()).toEqual([
      "app:config:get",
      "app:config:view",
    ]);
  });

  test("omits every unsafe app config id from the MCP registry", () => {
    const ids = fullRegistry().commandEntries.map((command) => command.spec.id);

    for (const id of appConfigUnsafeIds) expect(ids).not.toContain(id);
    expect(ids).toContain("app:config:get");
    expect(ids).toContain("app:config:view");
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
      mcpListResult(registry, { allow: ["app:config:get"] }).pipe(Effect.provide(configLayer(undefined))),
    );
    expect(result.tools).toEqual([
      { id: "app:config:get", summary: "App config", source: "default+allow" },
      { id: "app:info", summary: "Show app info", source: "default" },
    ]);
  });

  test("deny (global config) removes an id from the effective list", async () => {
    const result = await Effect.runPromise(
      mcpListResult(registry, { allow: ["app:config:get"] }).pipe(
        Effect.provide(configLayer({ deny: ["app:info"] })),
      ),
    );
    expect(result.tools.map((tool) => tool.id)).toEqual(["app:config:get"]);
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

  test("fails with McpToolInputError when the app config umbrella is explicitly allowed", async () => {
    const projected = mcpRegistryFromCompiled({
      "app:config": { landoSpec: entry("app:config", "App config").spec },
    });

    const exit = await Effect.runPromiseExit(
      mcpListResult(projected, { allow: ["app:config"] }).pipe(Effect.provide(configLayer(undefined))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(McpToolInputError);
      if (exit.cause.error instanceof McpToolInputError) {
        expect(exit.cause.error.toolId).toBe("app:config");
      }
    }
  });

  test("fails with McpToolInputError before cataloging when unsafe app config ids are flag-allowed", async () => {
    for (const id of appConfigUnsafeIds) {
      const exit = await Effect.runPromiseExit(
        mcpListResult(fullRegistry(), { allow: [id] }).pipe(Effect.provide(configLayer(undefined))),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(McpToolInputError);
        if (exit.cause.error instanceof McpToolInputError) expect(exit.cause.error.toolId).toBe(id);
      }
    }
  });

  test("fails with McpToolInputError before cataloging when unsafe app config ids are globally allowed", async () => {
    for (const id of appConfigUnsafeIds) {
      const exit = await Effect.runPromiseExit(
        mcpListResult(fullRegistry(), {}).pipe(Effect.provide(configLayer({ allow: [id] }))),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(McpToolInputError);
        if (exit.cause.error instanceof McpToolInputError) expect(exit.cause.error.toolId).toBe(id);
      }
    }
  });
});
