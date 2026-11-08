import { expect, test } from "bun:test";
import { GlobalAutoStartError, McpTransportError, ProviderUnavailableError } from "@lando/sdk/errors";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import { dispatchTool } from "../src/dispatch";
import { commandResult, rejectionResult } from "../src/tool-result";

test("MCP inspection and tool responses preserve redacted wrapped command causes", () => {
  const redactor = createRedactor("secrets", { values: ["private-state"] });
  const error = new GlobalAutoStartError({
    app: "app1",
    services: ["traefik"],
    message: "Failed to auto-start global services.",
    cause: new ProviderUnavailableError({
      providerId: "lando",
      operation: "applied-state.read",
      message: "Cannot read private-state.",
      remediation: "Restore the file.",
    }),
  });
  const entry = {
    spec: { id: "app:start", summary: "Start app", resultSchema: Schema.Void, run: () => Effect.void },
  };

  const response = Effect.runSync(
    dispatchTool(
      { toolId: entry.spec.id },
      {
        registry: new Map([[entry.spec.id, entry]]),
        effective: new Set([entry.spec.id]),
        allowlistSource: "defaults",
        redactor,
        resultRedactor: () => Effect.succeed(redactor),
        execute: () =>
          Effect.succeed({ _tag: "failure", error, additionalErrors: [{ role: "cleanup", error }] }),
      },
    ).pipe(Effect.flatMap((result) => commandResult(result, { redactor }))),
  );

  const cause = {
    _tag: "ProviderUnavailableError",
    message: "Cannot read [redacted].",
    operation: "applied-state.read",
  };
  expect(response.structuredContent).toMatchObject({
    error: { cause, additionalErrors: [{ role: "cleanup", cause }] },
  });
  expect(response.content[0]).toMatchObject({ type: "text" });
  expect(JSON.parse(response.content[0]?.type === "text" ? response.content[0].text : "null")).toEqual(
    response.structuredContent,
  );
  expect(JSON.stringify(response)).not.toContain("private-state");
  expect(response.isError).toBe(true);
});

test("MCP rejection reprojection preserves a redacted tagged cause", () => {
  const redactor = createRedactor("secrets", { values: ["private-state"] });
  const error = new McpTransportError({
    message: "Call failed.",
    remediation: "Retry.",
    cause: { _tag: "StateStoreError", message: "Cannot read private-state.", remediation: "Restore." },
  });

  const response = Effect.runSync(rejectionResult(error, { toolId: "app:info", redactor }));

  expect(response.structuredContent).toMatchObject({
    error: { cause: { _tag: "StateStoreError", message: "Cannot read [redacted]." } },
  });
  expect(JSON.stringify(response)).not.toContain("private-state");
});
