import { expect, test } from "bun:test";
import { dispatchTool } from "@lando/mcp/dispatch";
import { outcomeFromExit } from "@lando/mcp/execute";
import type { McpCommandEntry } from "@lando/mcp/registry";
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
