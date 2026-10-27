import { expect, test } from "bun:test";
import { dispatchTool } from "@lando/mcp/dispatch";
import { outcomeFromExit } from "@lando/mcp/execute";
import type { McpCommandEntry } from "@lando/mcp/registry";
import { encodeCommandResult, failureOutcomeFromCause } from "@lando/sdk/command-result";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { Cause, Effect, Schema } from "effect";

test("dispatch retains and redacts combined failures without invoking unsafe fields", async () => {
  // Given: operation and cleanup failures with secret-bearing fields and hostile extras.
  const secret = "combined-mcp-cleanup-token";
  let hookCalls = 0;
  const secondary = { _tag: "CleanupError", message: `cleanup ${secret}`, remediation: `repair ${secret}` };
  const command = Effect.failCause(
    Cause.combine(
      Cause.fail({ _tag: "StartError", message: `start ${secret}`, remediation: "Repair start." }),
      Cause.fail(secondary),
    ),
  );
  const entry: McpCommandEntry = {
    spec: { id: "app:start", summary: "Start app", resultSchema: Schema.Void, run: () => command },
  };
  Object.defineProperty(secondary, "unsafe", {
    enumerable: true,
    get: () => {
      hookCalls += 1;
      return secret;
    },
  });
  Object.defineProperty(secondary, "detail", {
    enumerable: true,
    value: new Proxy(
      {},
      {
        getPrototypeOf: () => {
          hookCalls += 1;
          return Object.prototype;
        },
        ownKeys: () => {
          hookCalls += 1;
          return [];
        },
      },
    ),
  });
  // When: dispatch executes the command through the production outcome projection and inspector.
  const result = await Effect.runPromise(
    dispatchTool(
      { toolId: "app:start" },
      {
        registry: new Map([[entry.spec.id, entry]]),
        effective: new Set([entry.spec.id]),
        allowlistSource: "defaults",
        redactor: createRedactor("secrets", { values: [secret] }),
        resultRedactor: (tokens) =>
          Effect.succeed(createRedactor("secrets", { values: [secret, ...tokens] })),
        execute: () => Effect.flatMap(Effect.exit(command), outcomeFromExit),
        publish: () => Effect.void,
      },
    ),
  );
  // Then: the redacted envelope retains both failures without invoking unsafe data.
  expect(result.ok).toBe(false);
  expect(result.envelope).toMatchObject({
    error: {
      _tag: "StartError",
      message: "start [redacted]",
      additionalErrors: [
        { _tag: "CleanupError", message: "cleanup [redacted]", remediation: "repair [redacted]" },
      ],
    },
  });
  expect(JSON.stringify(result.envelope)).not.toContain(secret);
  expect(hookCalls).toBe(0);
});

for (const stage of ["dispatch", "body"] as const) {
  test(`${stage} defects return the same redacted envelope as CLI encoding`, async () => {
    const secret = "mcp-private-defect-token";
    const defect = new Error(`Unexpected failure ${secret}\n    at embedded-stack`);
    const command = Effect.die(defect);
    const entry: McpCommandEntry = {
      spec: { id: "app:info", summary: "Info", resultSchema: Schema.Unknown, run: () => command },
    };
    const redactor = createRedactor("secrets", { values: [secret] });
    const result = await Effect.runPromise(
      dispatchTool(
        { toolId: entry.spec.id },
        {
          registry: new Map([[entry.spec.id, entry]]),
          effective: new Set([entry.spec.id]),
          allowlistSource: "defaults",
          redactor,
          resultRedactor: () => Effect.succeed(redactor),
          execute: () =>
            stage === "dispatch" ? command : Effect.flatMap(Effect.exit(command), outcomeFromExit),
          publish: () => Effect.void,
        },
      ),
    );
    const cli = JSON.parse(
      await Effect.runPromise(
        encodeCommandResult({
          command: entry.spec.id,
          resultSchema: Schema.Unknown,
          redactor,
          outcome: failureOutcomeFromCause(Cause.die(defect)),
          output: { chunks: [], truncated: false },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(Schema.decodeUnknownSync(CommandResultEnvelope)(result.envelope)).toEqual(cli);
    expect(result.envelope).toMatchObject({ ok: false, error: { _tag: "LandoInternalError" } });
    expect(JSON.stringify(result.envelope)).not.toContain(secret);
    expect(JSON.stringify(result.envelope)).not.toContain("embedded-stack");
  });
}

test("MCP and CLI preserve identical typed diagnostic fields and validation issues", async () => {
  const error = {
    _tag: "ExampleValidationError",
    message: "Invalid configuration.",
    remediation: "Set service.web.port.",
    detail: "A port is required.",
    service: "web",
    port: 0,
    issues: [{ path: ["services", "web", "port"], message: "Expected a positive port." }],
  };
  const entry: McpCommandEntry = {
    spec: { id: "app:info", summary: "Info", resultSchema: Schema.Unknown, run: () => Effect.fail(error) },
  };
  const redactor = createRedactor("secrets", { values: [] });
  const outcome = failureOutcomeFromCause(Cause.fail(error));
  const result = await Effect.runPromise(
    dispatchTool(
      { toolId: entry.spec.id },
      {
        registry: new Map([[entry.spec.id, entry]]),
        effective: new Set([entry.spec.id]),
        allowlistSource: "defaults",
        redactor,
        resultRedactor: () => Effect.succeed(redactor),
        execute: () => Effect.succeed(outcome),
        publish: () => Effect.void,
      },
    ),
  );
  const cli = JSON.parse(
    await Effect.runPromise(
      encodeCommandResult({
        command: entry.spec.id,
        resultSchema: Schema.Unknown,
        redactor,
        outcome,
        output: { chunks: [], truncated: false },
      }),
    ),
  );
  expect(result.envelope).toEqual(cli);
  expect(cli.error).toEqual(error);
});
