import { expect, test } from "bun:test";
import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import { dispatchTool } from "@lando/mcp/dispatch";
import type { McpCommandEntry } from "@lando/mcp/registry";
import { RedactionService } from "@lando/redaction/service";
import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import { buildMcpListResult } from "../../src/cli/commands/meta/mcp-list";
import { defaultIdsOf, knownIdsOf, validateMcpAllowlistIds } from "../../src/cli/commands/meta/mcp-registry";
import { mcpRegistryWithPlugins } from "../../src/mcp-plugins";
import { bundledMcpRegistry, pluginFixtureGraph } from "./plugin-fixture";

const spec: ExecutableCommandSpec = {
  id: "fixture:inspect",
  namespace: "fixture",
  bootstrap: "app",
  resultSchema: Schema.String,
  run: () => Effect.succeed("inspected"),
};

const registryFor = (command = spec, options: Parameters<typeof pluginFixtureGraph>[1] = {}) =>
  mcpRegistryWithPlugins({ commandEntries: [] }).pipe(
    Effect.provideService(PluginContributionGraph, pluginFixtureGraph(command, options)),
    Effect.provide(RedactionService.layer),
  );

test("bundled db:snapshots defaults and explicit db:export validate and list", async () => {
  const registry = await Effect.runPromise(bundledMcpRegistry().pipe(Effect.provide(RedactionService.layer)));
  await Effect.runPromise(
    validateMcpAllowlistIds({ allow: ["db:export"], deny: [], tooling: false }, knownIdsOf(registry)),
  );
  const result = buildMcpListResult({
    ...registry,
    defaultAllowlist: defaultIdsOf(registry),
    allow: ["db:export"],
  });
  expect(result.tools).toContainEqual(
    expect.objectContaining({
      id: "db:snapshots",
      source: "default",
      plugin: { name: "@lando/sql", source: "bundled", provenance: "bundled" },
    }),
  );
  expect(result.tools).toContainEqual(
    expect.objectContaining({ id: "db:export", source: "allow", destructive: true }),
  );
});

test("external mcpAllowed commands need explicit allowance", async () => {
  const registry = await Effect.runPromise(registryFor());
  const input = { ...registry, defaultAllowlist: defaultIdsOf(registry) };
  expect(buildMcpListResult(input).tools).toEqual([]);
  expect(buildMcpListResult({ ...input, allow: [spec.id] }).tools).toContainEqual(
    expect.objectContaining({
      id: spec.id,
      plugin: { name: "@example/mcp", source: "external", provenance: "user" },
      source: "allow",
    }),
  );
});

test("external replacement cannot inherit the bundled db:snapshots default", async () => {
  const registry = await Effect.runPromise(registryFor({ ...spec, id: "db:snapshots", namespace: "db" }));
  expect(defaultIdsOf(registry)).not.toContain("db:snapshots");
  expect(buildMcpListResult({ ...registry, defaultAllowlist: defaultIdsOf(registry) }).tools).toEqual([]);
});

test("a yes declaration conflicts with self-allow but stays explicitly allowable", async () => {
  const registry = await Effect.runPromise(
    registryFor({ ...spec, flags: { yes: { type: "boolean" } } }, { source: "bundled" }),
  );
  const result = buildMcpListResult({ ...registry, defaultAllowlist: defaultIdsOf(registry) });
  expect(result.tools).toEqual([]);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ _tag: "McpAllowlistConflictError" }));
  await Effect.runPromise(
    validateMcpAllowlistIds({ allow: [spec.id], deny: [], tooling: false }, knownIdsOf(registry)),
  );
  expect(
    buildMcpListResult({ ...registry, defaultAllowlist: [], allow: [spec.id] }).tools[0]?.destructive,
  ).toBe(true);
});

test("deny wins over a plugin's explicit allow", async () => {
  const registry = await Effect.runPromise(registryFor());
  expect(
    buildMcpListResult({ ...registry, defaultAllowlist: [], allow: [spec.id], deny: [spec.id] }).tools,
  ).toEqual([]);
});

test("invalid loaded specs are excluded with diagnostics, not promoted or accepted as allow ids", async () => {
  const registry = await Effect.runPromise(registryFor({ ...spec, namespace: "different" }));
  expect(registry.commandEntries).toEqual([]);
  expect(registry.diagnostics).toContainEqual(
    expect.objectContaining({ _tag: "PluginDescriptorMismatchError" }),
  );
  const result = await Effect.runPromise(
    Effect.result(
      validateMcpAllowlistIds({ allow: [spec.id], deny: [], tooling: false }, knownIdsOf(registry)),
    ),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "McpToolInputError" } });
});

test("a failing loader is excluded and reported without losing sibling commands", async () => {
  const graph = pluginFixtureGraph(spec);
  const candidate = graph.commands[0];
  if (candidate === undefined) throw new Error("Missing candidate");
  const broken = {
    ...candidate,
    id: "fixture:broken",
    descriptor: { ...candidate.descriptor, id: "fixture:broken" },
    load: async () => {
      throw new Error("fixture loader failed");
    },
  };
  const registry = await Effect.runPromise(
    mcpRegistryWithPlugins({ commandEntries: [] }).pipe(
      Effect.provideService(PluginContributionGraph, { ...graph, commands: [broken, candidate] }),
      Effect.provide(RedactionService.layer),
    ),
  );
  expect(registry.commandEntries.map((entry) => entry.spec.id)).toEqual([spec.id]);
  expect(registry.diagnostics).toContainEqual(expect.objectContaining({ _tag: "PluginLoadError" }));
});

const tether = "app:remote:tether";

test("a plugin declaring app:remote:tether is never admitted to the MCP registry", async () => {
  // Given a plugin that declares tether as an MCP-allowed command
  // When the MCP registry admits plugin commands
  const registry = await Effect.runPromise(registryFor({ ...spec, id: tether, namespace: "app" }));
  // Then tether is absent and the refusal is reported
  expect(knownIdsOf(registry).has(tether)).toBe(false);
  expect(registry.diagnostics).toContainEqual(
    expect.objectContaining({ _tag: "McpAllowlistConflictError", message: expect.stringContaining(tether) }),
  );
});

test("--allow rejects app:remote:tether even when the id is otherwise known", async () => {
  // Given an allow list naming tether and a registry that knows the id
  // When the allow ids are validated
  const result = await Effect.runPromise(
    Effect.result(validateMcpAllowlistIds({ allow: [tether], deny: [], tooling: false }, new Set([tether]))),
  );
  // Then validation fails before the session starts
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "McpToolInputError", toolId: tether } });
});

test("dispatch refuses app:remote:tether even when registered and allowed", async () => {
  // Given a registry and effective allowlist that both contain tether
  let executed = 0;
  const entry: McpCommandEntry = {
    spec: {
      id: tether,
      summary: "Tether fixture",
      resultSchema: Schema.String,
      run: () => Effect.succeed("ran"),
    },
  };
  // When a client calls the tool
  const exit = await Effect.runPromise(
    Effect.exit(
      dispatchTool(
        { toolId: tether },
        {
          registry: new Map([[tether, entry]]),
          effective: new Set([tether]),
          allowlistSource: "allow",
          redactor: createRedactor("secrets", { values: [] }),
          resultRedactor: () => Effect.succeed(createRedactor("secrets", { values: [] })),
          execute: () =>
            Effect.sync(() => {
              executed++;
              return { _tag: "success" as const, value: "ran" };
            }),
        },
      ),
    ),
  );
  // Then the call is rejected without executing
  expect(exit).toMatchObject({ _tag: "Failure" });
  expect(JSON.stringify(exit)).toContain("McpToolNotAllowedError");
  expect(executed).toBe(0);
});
