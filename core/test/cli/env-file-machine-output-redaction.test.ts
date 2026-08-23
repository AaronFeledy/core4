import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { type McpDispatchDeps, dispatchTool } from "@lando/mcp/dispatch";
import type { McpCommandEntry } from "@lando/mcp/registry";
import { createBufferedRendererIO } from "@lando/renderer/io";
import type { CommandResultOutcome } from "@lando/sdk/command-result";
import { REDACTED, createRedactor } from "@lando/sdk/secrets";

import { appConfigMcpSpecs, appConfigSpec } from "../../src/cli/command-specs/app/config/index.ts";
import { execSpec } from "../../src/cli/command-specs/app/exec.ts";
import { appConfigRedactionTokens } from "../../src/cli/commands/app-config.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const JSON_CANARY = "env-file-json-canary";
const CONFIG_CANARY = "config-canary";

const ExecJsonResultSchema = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Number,
});

const authoredLandofile = {
  services: {
    app: {
      environment: { PASSWORD: CONFIG_CANARY },
    },
  },
};

const dispatchDeps = (entry: McpCommandEntry): McpDispatchDeps => ({
  registry: new Map([[entry.spec.id, entry]]),
  effective: new Set([entry.spec.id]),
  allowlistSource: "defaults",
  redactor: createRedactor("secrets", { values: [] }),
  execute: () =>
    Effect.succeed({
      _tag: "success",
      value: {
        landofile: authoredLandofile,
      },
    } satisfies CommandResultOutcome),
  publish: () => Effect.void,
});

describe("env_file machine-output redaction", () => {
  test("redacts JSON exec stdout when tokens come from execSpec.redactionTokens", async () => {
    // Given
    const extractTokens = execSpec.redactionTokens;
    expect(extractTokens).toBeFunction();
    if (extractTokens === undefined) return;
    const io = createBufferedRendererIO();

    // When
    await runWithRendererHandling(
      Effect.succeed({
        app: "demo",
        service: "app",
        command: ["printenv", "DB_PASSWORD"],
        exitCode: 0,
        stdout: JSON_CANARY,
        stderr: "",
        redactionTokens: [JSON_CANARY],
      }),
      {
        runtime: Layer.empty,
        rendererMode: "plain",
        resultFormat: "json",
        command: "app:exec",
        resultSchema: ExecJsonResultSchema,
        io,
        redactionTokens: extractTokens,
        formatError: String,
        setExitCode: () => undefined,
      },
    );

    // Then
    const encoded = io.stdout();
    expect(encoded).toContain(REDACTED);
    expect(encoded).not.toContain(JSON_CANARY);
    expect(encoded).not.toContain("redactionTokens");
  });

  test("omits an authored landofile environment canary from JSON config output", async () => {
    // Given
    expect(appConfigRedactionTokens({ landofile: authoredLandofile })).toContain(CONFIG_CANARY);
    const io = createBufferedRendererIO();

    // When
    await runWithRendererHandling(
      Effect.succeed({
        app: "demo",
        source: "resolved" as const,
        landofile: authoredLandofile,
      }),
      {
        runtime: Layer.empty,
        rendererMode: "plain",
        resultFormat: "json",
        command: "app:config",
        resultSchema: appConfigSpec.resultSchema,
        io,
        redactionTokens: appConfigRedactionTokens,
        formatError: String,
        setExitCode: () => undefined,
      },
    );

    // Then
    const encoded = io.stdout();
    expect(encoded).toContain(REDACTED);
    expect(encoded).not.toContain(CONFIG_CANARY);
    expect(encoded).not.toContain("redactionTokens");
  });

  test("omits an authored landofile environment canary from the config view MCP envelope", async () => {
    // Given
    const viewSpec = appConfigMcpSpecs.find((spec) => spec.id === "app:config:view");
    expect(viewSpec).toBeDefined();
    if (viewSpec === undefined) return;
    expect(viewSpec.redactionTokens).toBeFunction();

    // When
    const result = await Effect.runPromise(
      dispatchTool({ toolId: "app:config:view" }, dispatchDeps({ spec: viewSpec })),
    );

    // Then
    expect(JSON.stringify(result.envelope)).toContain(REDACTED);
    expect(JSON.stringify(result.envelope)).not.toContain(CONFIG_CANARY);
  });
});
