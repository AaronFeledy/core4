import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  type GuideScenarioAst,
  type GuideScenarioNode,
  buildPublicTranscript,
  parseGuideScenarioAst,
  renderScenarioTest,
} from "../../../scripts/build-guide-scenarios.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const guidePath = "docs/guides/agent-native/mcp.mdx";

const readText = async (path: string): Promise<string> => Bun.file(resolve(repoRoot, path)).text();

const scenarioById = (guide: GuideScenarioAst, id: string): GuideScenarioNode => {
  const scenario = guide.scenarios.find((candidate) => candidate.id === id);
  expect(scenario, `expected scenario ${id}`).toBeDefined();
  if (scenario === undefined) throw new Error(`expected scenario ${id}`);
  return scenario;
};

const libraryRun = (scenario: GuideScenarioNode) => {
  const component = scenario.steps
    .flatMap((step) => step.components)
    .find(
      (candidate) =>
        candidate.kind === "Run" && "runtime" in candidate.props && candidate.props.runtime === "library",
    );
  expect(component, `expected ${scenario.id} to execute a library run`).toBeDefined();
  if (component?.kind !== "Run" || !("runtime" in component.props)) {
    throw new Error(`expected ${scenario.id} to execute a library run`);
  }
  return component.props;
};

describe("MCP executable guide", () => {
  test("publishes the MCP guide INDEX rows as shipped", async () => {
    const index = await readText("docs/guides/INDEX.md");

    expect(index).toContain(
      "| BETA1-PRD-06 | US-398 | `lando mcp` setup and `--list` audit | `docs/guides/agent-native/mcp.mdx` | Shipped |",
    );
    expect(index).toContain(
      "| BETA1-PRD-14 | US-452 | MCP serve startup, refusal, bounded stdio, and read-only app config | `docs/guides/agent-native/mcp.mdx` | Shipped |",
    );
  });

  test("executes the successful conversation, startup refusals, and bounded read-only contract", async () => {
    const guide = parseGuideScenarioAst(guidePath, await readText(guidePath));
    expect(guide.scenarios.length).toBeGreaterThanOrEqual(3);
    expect(guide.frontmatter).toMatchObject({
      id: "mcp",
      provider: "test",
      platforms: ["darwin", "linux", "win32", "wsl"],
    });

    const conversation = scenarioById(guide, "stdio-conversation");
    const conversationRun = libraryRun(conversation);
    expect(conversationRun.code).toContain("mcpRegistryFromBuiltIns");
    expect(conversationRun.code).toContain("makeStdioClient");
    expect(conversationRun.code).toContain("McpRuntimeConfig");
    expect(conversationRun.code).toContain("serviceLayer: mcpServiceLayer");
    expect(conversationRun.code).toContain("Effect.provideService(Stdio.Stdio, client.stdio)");
    expect(conversationRun.code).toContain("RedactionService");
    expect(conversationRun.code).toContain("LandofileService");
    expect(conversationRun.code).toContain('name: "mcp-guide", services: {}');
    expect(conversationRun.code).toContain("yield* client.initialize({})");
    expect(conversationRun.displayCode).toContain('method: "initialize"');
    expect(conversationRun.displayCode).toContain('method: "notifications/initialized"');
    expect(conversationRun.code).toContain('client.request("tools/list")');
    expect(conversationRun.code).toContain(
      'result: { protocolVersion: "2025-06-18", serverInfo: { name: "lando" } }',
    );
    expect(conversationRun.code).toContain(
      'name: "app:config:get", outputSchema: expect.objectContaining({ type: "object" })',
    );
    expect(conversationRun.code).toContain(
      'name: "app:config:view", outputSchema: expect.objectContaining({ type: "object" })',
    );
    expect(conversationRun.code).toContain(
      'structuredContent: { ok: true, command: "app:config:get", result: { value: "mcp-guide" } }',
    );
    expect(conversationRun.code).toContain('name: "app:config:get"');
    expect(conversationRun.code).toContain("service.serve");
    expect(conversationRun.code).toContain("Effect.timeout");
    expect(conversationRun.code).toContain("Fiber.join");
    expect(conversationRun.code).toContain("isError: false");
    expect(conversationRun.code).toMatch(/expect\(callText\)\.toContain\([^)]*app:config:get/);
    expect(conversationRun.code).toMatch(/expect\(callText\)\.toContain\([^)]*mcp-guide/);
    expect(conversationRun.code).not.toContain("transport.reply");
    expect(conversationRun.displayCode).toContain('Bun.spawn(["lando", "mcp"]');
    expect(conversationRun.displayCode).toContain("await child.stdin.write");
    expect(conversationRun.displayCode).toContain("pending = new Set([1, 2, 3])");
    expect(conversationRun.displayCode).toContain("child.stdout.getReader()");
    expect(conversationRun.displayCode).toContain("await child.stdin.end()");
    expect(conversationRun.displayCode).toContain("new Response(child.stderr).text()");
    expect(conversationRun.displayCode).toContain("child.exited");
    expect(conversationRun.displayCode.indexOf("pending = new Set([1, 2, 3])")).toBeLessThan(
      conversationRun.displayCode.indexOf("await child.stdin.end()"),
    );

    const refusals = libraryRun(scenarioById(guide, "startup-refusals"));
    expect(refusals.code).toContain("classifyMcpServeStartup");
    expect(refusals.code).toContain('resultFormat: "json"');
    expect(refusals.code).toContain('kind: "character"');
    expect(refusals.code).toContain("available: false");
    expect(refusals.displayCode).toContain("await catalog.stdin.end()");
    expect(refusals.displayCode).toContain("new Response(catalog.stdout).text()");
    expect(refusals.displayCode).toContain("new Response(catalog.stderr).text()");
    expect(refusals.displayCode).toContain("catalog.exited");

    const bounded = libraryRun(scenarioById(guide, "bounded-read-only-regressions"));
    expect(bounded.code).toContain("mcpRegistryFromBuiltIns");
    expect(bounded.code).toContain("MAX_OUTSTANDING_REQUESTS");
    expect(bounded.code).toContain('Effect.timeout("5 seconds")');
    expect(bounded.code).toContain("isError: Schema.Literal(true)");
    expect(bounded.code).toContain('type: Schema.Literal("text"), text: Schema.String');
    expect(bounded.code).toContain('expect(JSON.parse(busyResult.content[0]?.text ?? "{}")).toEqual');
    expect(bounded.code).toContain('_tag: "McpTransportError"');
    expect(bounded.code).toContain('message: "Server busy"');
    expect(bounded.code).toContain("expect(busyResult.structuredContent).toBeUndefined()");
    expect(bounded.code).toContain(
      'expect(observed.busy).toMatchObject({ jsonrpc: "2.0", id: observed.busyId })',
    );
    expect(bounded.code).toContain("expect(observed.results).toHaveLength(MAX_OUTSTANDING_REQUESTS + 1)");
    expect(bounded.code).toContain("expect(succeeded).toHaveLength(MAX_OUTSTANDING_REQUESTS)");
    expect(bounded.code).toContain('["app:config:get", "app:config:view"]');

    const resources = libraryRun(scenarioById(guide, "resources-and-schema-completion"));
    expect(resources.code).toContain("core/src/mcp-resources.ts");
    expect(resources.code).toContain('client.request("resources/list")');
    expect(resources.code).toContain('client.request("resources/templates/list")');
    expect(resources.code).toContain('client.request("completion/complete"');
    for (const uri of ["lando://app/config", "lando://app/info", "lando://apps", "lando://doctor"]) {
      expect(resources.code).toContain(`"${uri}"`);
    }
    expect(resources.code).toContain('ref: { type: "ref/resource", uri: "lando://schemas/{name}" }');
    expect(resources.code).toContain('JSON_SCHEMA_NAMES.filter((name) => name.startsWith("CommandResult"))');
    expect(resources.code).toContain("expect(expected.length).toBeGreaterThan(0)");
    expect(resources.code).toContain("result: { completion: { values: expected, hasMore: false } }");

    for (const scenario of guide.scenarios) {
      const generated = renderScenarioTest(guide, scenario, undefined, "linux");
      expect(generated).toContain('import * as LandoCore from "@lando/core";');
      expect(generated).toContain("LandoTesting.withScenarioContext(");
      expect(generated).not.toContain("context.runCli(");
    }

    const transcript = buildPublicTranscript(guide, conversation, undefined);
    expect(transcript?.runtime).toBe("library");
    expect(JSON.stringify(transcript)).not.toContain("../../../../../mcp/src");

    const boundedTranscript = buildPublicTranscript(
      guide,
      scenarioById(guide, "bounded-read-only-regressions"),
      undefined,
    );
    expect(boundedTranscript?.frames).toContainEqual(
      expect.objectContaining({ kind: "step", displayText: "verify-read-only-tools" }),
    );
    expect(JSON.stringify(boundedTranscript)).not.toContain("<PROVIDER_ID>");
  });
});
