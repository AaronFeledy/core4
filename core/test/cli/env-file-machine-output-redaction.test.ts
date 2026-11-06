import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { type McpDispatchDeps, dispatchTool } from "@lando/mcp/dispatch";
import type { McpCommandEntry } from "@lando/mcp/registry";
import { createBufferedRendererIO } from "@lando/renderer/io";
import type { CommandResultOutcome } from "@lando/sdk/command-result";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { REDACTED, createRedactor } from "@lando/sdk/secrets";

import { appConfigMcpSpecs, appConfigSpec } from "../../src/cli/command-specs/app/config/index.ts";
import { execSpec } from "../../src/cli/command-specs/app/exec.ts";
import { appConfigRedactionTokens } from "../../src/cli/commands/app-config.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import type { LandoCommandSpec } from "../../src/cli/spec/command-spec.ts";

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
  resultRedactor: (tokens) => Effect.succeed(createRedactor("secrets", { values: tokens })),
  execute: () =>
    Effect.succeed({
      _tag: "success",
      value: {
        source: "resolved" as const,
        landofile: authoredLandofile,
      },
    } satisfies CommandResultOutcome),
  publish: () => Effect.void,
});

describe("env_file machine-output redaction", () => {
  for (const format of ["json", "yaml"] as const) {
    test(`preserves primitive values in ${format} when invocation secrets match JSON literals`, async () => {
      const io = createBufferedRendererIO();
      await runWithRendererHandling(
        Effect.succeed({
          enabled: true,
          disabled: false,
          empty: null,
          count: 12345,
          strings: ["true", "false", "null", "12345"],
        }),
        {
          sourceEnv: {
            SYNTHETIC_SECRET: "true",
            SYNTHETIC_PASSWORD: "false",
            SYNTHETIC_TOKEN: "null",
            SYNTHETIC_API_KEY: "12345",
          },
          runtime: Layer.empty,
          rendererMode: "plain",
          resultFormat: format,
          command: "qa:primitive-redaction",
          resultSchema: Schema.Unknown,
          io,
          formatError: ({ error }) => String(error),
          setExitCode: () => undefined,
        },
      );
      const parsed = format === "json" ? JSON.parse(io.stdout()) : Bun.YAML.parse(io.stdout());
      expect(Schema.decodeUnknownSync(CommandResultEnvelope)(parsed)).toMatchObject({
        ok: true,
        result: {
          enabled: true,
          disabled: false,
          empty: null,
          count: 12345,
          strings: [REDACTED, REDACTED, REDACTED, REDACTED],
        },
      });
    });
  }

  test("retains the invocation environment snapshot when the caller mutates its environment", async () => {
    // Given: a caller-owned environment that will change during execution.
    const secret = "invocation-snapshot-canary";
    const sourceEnv = { API_SECRET: secret };
    const io = createBufferedRendererIO();
    // When: execution changes the caller's map before the final result is rendered.
    await runWithRendererHandling(
      Effect.sync(() => {
        sourceEnv.API_SECRET = "replacement-environment-value";
        return { value: secret };
      }),
      {
        sourceEnv,
        runtime: Layer.empty,
        rendererMode: "plain",
        resultFormat: "json",
        command: "qa:snapshot",
        resultSchema: Schema.Struct({ value: Schema.String }),
        io,
        formatError: ({ error }) => String(error),
        setExitCode: () => undefined,
      },
    );
    // Then: rendering masks the invocation's original secret, not only the replacement.
    expect(JSON.parse(io.stdout())).toMatchObject({ result: { value: REDACTED } });
  });

  test("redacts JSON exec stdout when tokens come from execSpec.redactionTokens", async () => {
    // Given
    const extractTokens = execSpec.redactionTokens;
    const execResult = {
      app: "demo",
      service: "app",
      command: ["printenv", "DB_PASSWORD"],
      exitCode: 0,
      stdout: JSON_CANARY,
      stderr: "",
      redactionTokens: [JSON_CANARY],
    };
    expect(extractTokens?.(execResult)).toContain(JSON_CANARY);
    if (extractTokens === undefined) {
      throw new Error("execSpec.redactionTokens must be wired");
    }
    const io = createBufferedRendererIO();

    // When
    await runWithRendererHandling(Effect.succeed(execResult), {
      runtime: Layer.empty,
      rendererMode: "plain",
      resultFormat: "json",
      command: "app:exec",
      resultSchema: ExecJsonResultSchema,
      io,
      redactionTokens: extractTokens,
      formatError: ({ error }) => String(error),
      setExitCode: () => undefined,
    });

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
        formatError: ({ error }) => String(error),
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
    const viewSpec: LandoCommandSpec | undefined = appConfigMcpSpecs.find(
      (spec) => spec.id === "app:config:view",
    );
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
