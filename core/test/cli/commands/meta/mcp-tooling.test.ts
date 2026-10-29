import { describe, expect, test } from "bun:test";
import { bindToolingInput, lowerToolingInput } from "@lando/landofile/tooling-input";
import { normalizeToolingInput } from "@lando/landofile/tooling-input-normalize";
import { dispatchTool } from "@lando/mcp/dispatch";
import { McpCommandExecutor } from "@lando/mcp/port";
import { deriveToolInputSchema } from "@lando/mcp/registry";
import { McpRuntimeConfig, McpService } from "@lando/mcp/service";
import { startStdioClient } from "@lando/mcp/testing";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { resolveCommandCompletion } from "@lando/sdk/command-result";
import { McpTransportError } from "@lando/sdk/errors";
import type { LandoEvent } from "@lando/sdk/events";
import { Effect, Layer, Result, Schema } from "effect";
import { mcpRegistryWithToolingEntries } from "../../../../src/cli/commands/meta/mcp";

const registry = {
  commandEntries: [
    {
      spec: {
        id: "app:info",
        summary: "Show app info",
        resultSchema: Schema.Unknown,
        run: () => Effect.void,
      },
    },
  ],
};

describe("mcpRegistryWithToolingEntries", () => {
  const command = {
    id: "app:greet",
    summary: "Greet",
    hidden: false,
    input: Result.getOrThrow(
      normalizeToolingInput("greet", {
        flags: {
          name: { default: "world", description: "Recipient" },
          loud: { boolean: true },
          mode: { choices: ["dev", "prod"] },
        },
        args: { target: { required: true, choices: ["dev", "prod"] }, greeting: { default: "hello" } },
      }),
    ),
  };

  test("projects typed flags when tooling declares input", () => {
    // Given / When
    const projected = mcpRegistryWithToolingEntries(registry, [command]).toolingEntries?.[0]?.spec;
    // Then
    if (projected === undefined) throw new Error("Missing projection");
    expect(deriveToolInputSchema(projected)).toMatchObject({
      properties: {
        flags: {
          properties: {
            name: { type: "string", default: "world", description: "Recipient" },
            loud: { type: "boolean" },
            mode: { type: "string", enum: ["dev", "prod"] },
          },
        },
      },
    });
  });

  test("projects string args in declared order when tooling declares args", () => {
    // Given / When
    const projected = mcpRegistryWithToolingEntries(registry, [command]).toolingEntries?.[0]?.spec;
    // Then
    if (projected === undefined) throw new Error("Missing projection");
    expect(deriveToolInputSchema(projected)).toMatchObject({
      required: ["args"],
      properties: {
        args: {
          required: ["target"],
          properties: {
            target: { type: "string", enum: ["dev", "prod"] },
            greeting: { type: "string", default: "hello" },
          },
        },
      },
    });
  });

  test("preserves the exact passthrough member when tooling has no input", () => {
    // Given
    const passthrough = { ...command, input: Result.getOrThrow(normalizeToolingInput("greet", {})) };
    // When
    const projected = mcpRegistryWithToolingEntries(registry, [passthrough]).toolingEntries?.[0]?.spec;
    // Then
    if (projected === undefined) throw new Error("Missing projection");
    expect(deriveToolInputSchema(projected)).toMatchObject({
      properties: { args: { properties: { args: { type: "array", items: { type: "string" } } } } },
    });
  });

  test("binds named MCP values once with their authoritative defaults", () => {
    // Given
    const input = { flags: { loud: true, name: "Lando" }, args: { target: "dev" } };
    // When
    const values = Result.getOrThrow(
      bindToolingInput({ name: "greet" }, command.input, { _tag: "NamedMaps", ...input }),
    );
    // Then
    expect(values).toEqual({
      flags: { name: "Lando", loud: true },
      args: { target: "dev", greeting: "hello" },
    });
  });

  test("keeps leading-hyphen named positionals as values without parsing", () => {
    // Given
    const declaration = Result.getOrThrow(normalizeToolingInput("greet", { args: { target: {} } }));
    const input = { flags: {}, args: { target: "--literal" } };
    // When
    const values = Result.getOrThrow(
      bindToolingInput({ name: "greet" }, declaration, { _tag: "NamedMaps", ...input }),
    );
    // Then
    expect(values.args).toEqual({ target: "--literal" });
  });

  test("preserves false, omission and empty names while binding defaults", () => {
    // Given
    const input = { flags: { loud: false, name: "" }, args: { target: "prod", greeting: "hi there" } };
    // When
    const values = Result.getOrThrow(
      bindToolingInput({ name: "greet" }, command.input, { _tag: "NamedMaps", ...input }),
    );
    // Then
    expect(values).toEqual({
      flags: { loud: false, name: "" },
      args: { target: "prod", greeting: "hi there" },
    });
    expect(Object.hasOwn(values.flags, "mode")).toBe(false);
  });

  test("names the omitted positional instead of binding a later value to it", () => {
    // Given
    const declaration = Result.getOrThrow(
      normalizeToolingInput("greet", { args: { first: {}, second: {} } }),
    );
    // When
    const values = Result.getOrThrow(
      bindToolingInput({ name: "greet" }, declaration, {
        _tag: "NamedMaps",
        flags: {},
        args: { second: "b" },
      }),
    );
    const result = lowerToolingInput({ name: "greet" }, declaration, values);
    // Then
    expect(Result.isFailure(result)).toBe(true);
    expect(Result.isFailure(result) ? result.failure : undefined).toMatchObject({
      _tag: "ToolingInputError",
      tool: "greet",
      field: "first",
    });
  });

  test("projects visible registered tooling commands into MCP tooling entries", () => {
    // Given / When
    const projected = mcpRegistryWithToolingEntries(registry, [
      { id: "app:composer", summary: "Run Composer", hidden: false },
      { id: "app:hidden", summary: "Hidden", hidden: true },
    ]);
    // Then
    expect(projected.commandEntries).toEqual(registry.commandEntries);
    expect(projected.toolingEntries?.map((tooling) => tooling.spec.id)).toEqual(["app:composer"]);
    expect(projected.toolingEntries?.[0]?.tooling).toBe(true);
  });
});

for (const stage of ["success", "invalid", "denied", "busy"] as const) {
  test(`classifies retained sensitive input before MCP events (${stage})`, async () => {
    const canary = 'early-private-"note\\value';
    const command = {
      id: "app:private",
      summary: "Private tooling",
      hidden: false,
      input: Result.getOrThrow(normalizeToolingInput("private", { flags: { note: { sensitive: true } } })),
    };
    const entry = mcpRegistryWithToolingEntries(registry, [command]).toolingEntries?.[0];
    if (entry === undefined) throw new Error("Missing projection");
    const redaction = makeRedactionService();
    const events: LandoEvent[] = [];
    let executions = 0;
    const input = {
      flags: { note: canary },
      appPath: canary,
      ...(stage === "invalid" ? { [canary]: "extra" } : {}),
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const redactor = yield* redaction.forProfile("secrets", { sourceEnv: {} });
        yield* dispatchTool(
          { toolId: command.id, input },
          {
            registry: new Map([[command.id, entry]]),
            effective: new Set(stage === "denied" ? [] : [command.id]),
            ...(stage === "busy"
              ? { rejection: new McpTransportError({ message: "Server busy", remediation: "Retry later." }) }
              : {}),
            allowlistSource: "tooling",
            redactor,
            resultRedactor: (tokens) =>
              redaction.forProfile("secrets", { authoritativeTokens: tokens, sourceEnv: {} }),
            execute: () =>
              Effect.sync(() => {
                executions++;
                return resolveCommandCompletion(command.id, {
                  tool: "private",
                  service: "host",
                  exitCode: 0,
                  stdout: "",
                  stderr: "",
                });
              }),
            publish: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          },
        ).pipe(Effect.result);
      }).pipe(Effect.provideService(RedactionService, redaction)),
    );
    expect(events.map((event) => event._tag)).toEqual(["pre-mcp-call", "post-mcp-call"]);
    for (const event of events) {
      expect(event).not.toMatchObject({ appRef: canary });
      expect(JSON.stringify(event)).not.toContain(canary);
      expect(JSON.stringify(event)).not.toContain(JSON.stringify(canary).slice(1, -1));
      expect(event).not.toHaveProperty("appRef");
    }
    expect(executions).toBe(stage === "success" ? 1 : 0);
  });
}

test("actual MCP session rejects unknown tooling top-level names without retaining their bytes", async () => {
  const canary = 'early-rejection-"note\\value';
  const command = {
    id: "app:private",
    summary: "Private tooling",
    hidden: false,
    input: Result.getOrThrow(normalizeToolingInput("private", { flags: { note: { sensitive: true } } })),
  };
  const entry = mcpRegistryWithToolingEntries(registry, [command]).toolingEntries?.[0];
  if (entry === undefined) throw new Error("Missing projection");
  let executions = 0;
  const redaction = makeRedactionService();
  const response = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* McpService;
        const client = yield* startStdioClient(service.serve({ transport: "stdio" }));
        return yield* client.request("tools/call", {
          name: command.id,
          arguments: { flags: { note: canary }, [canary]: "extra" },
        });
      }),
    ).pipe(
      Effect.provide(
        McpService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(McpRuntimeConfig, {
                commandEntries: [entry],
                defaultAllowlist: [command.id],
                runtimeLayer: Layer.empty,
              }),
              Layer.succeed(McpCommandExecutor, {
                execute: (command, execution) =>
                  Effect.suspend(() => {
                    executions++;
                    return Effect.exit(
                      command.pipe(
                        Effect.map((value) =>
                          resolveCommandCompletion(execution.commandId, value, execution.completion),
                        ),
                      ),
                    );
                  }),
              }),
              Layer.succeed(RedactionService, redaction),
            ),
          ),
        ),
      ),
    ),
  );
  expect(executions).toBe(0);
  expect(response).toMatchObject({ result: { isError: true } });
  const text = JSON.stringify(response);
  expect(text).toContain("McpToolInputError");
  expect(text).not.toContain(canary);
  expect(text).not.toContain(JSON.stringify(canary).slice(1, -1));
  expect(text).not.toContain(JSON.stringify(JSON.stringify(canary).slice(1, -1)).slice(1, -1));
  const redactor = await Effect.runPromise(redaction.forProfile("secrets", { sourceEnv: {} }));
  expect(redactor.redactString(canary)).toBe("[redacted]");
});

for (const group of ["flags", "args"] as const) {
  test.each([null, [], "malformed", false, 42].map((value) => ({ value })))(
    `early tooling classifier tolerates malformed ${group} ($value)`,
    async ({ value }) => {
      const command = {
        id: "app:private",
        summary: "Private tooling",
        hidden: false,
        input: Result.getOrThrow(
          normalizeToolingInput("private", {
            flags: { note: { sensitive: true } },
            args: { note: { sensitive: true } },
          }),
        ),
      };
      const entry = mcpRegistryWithToolingEntries(registry, [command]).toolingEntries?.[0];
      if (entry === undefined) throw new Error("Missing projection");
      const supplied = JSON.parse(
        JSON.stringify({ flags: { note: "flag-canary" }, args: { note: "arg-canary" }, [group]: value }),
      );
      expect(entry.spec.inputRedactionTokens?.(supplied)).toEqual([
        group === "flags" ? "arg-canary" : "flag-canary",
      ]);
      let executions = 0;
      const redaction = makeRedactionService();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* dispatchTool(
            { toolId: command.id, input: supplied },
            {
              registry: new Map([[command.id, entry]]),
              effective: new Set([command.id]),
              allowlistSource: "tooling",
              redactor: yield* redaction.forProfile("secrets", { sourceEnv: {} }),
              resultRedactor: (tokens) =>
                redaction.forProfile("secrets", { sourceEnv: {}, authoritativeTokens: tokens }),
              execute: () =>
                Effect.sync(() => {
                  executions++;
                  return resolveCommandCompletion(command.id, undefined);
                }),
            },
          ).pipe(Effect.result);
        }),
      );
      expect(executions).toBe(0);
      expect(Result.isFailure(result) ? result.failure : undefined).toMatchObject({
        _tag: "McpToolInputError",
        path: group,
      });
    },
  );
}
