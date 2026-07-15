import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { McpTransportError } from "@lando/sdk/errors";

import { buildCommandResultEnvelope, identityRedactor } from "../../src/cli/result-encode.ts";
import { inspectMcpCommandOutcome, projectMcpProgressFrame } from "../../src/mcp/result-inspector.ts";

test("omits a hidden accessor before result-schema encoding", async () => {
  // Given
  let getterCalls = 0;
  const result = {};
  Object.defineProperty(result, "nested", {
    get: () => {
      getterCalls += 1;
      return { value: "not-read" };
    },
  });

  // When
  const envelope = await Effect.runPromise(
    inspectMcpCommandOutcome({ _tag: "success", value: result }).pipe(
      Effect.flatMap((outcome) =>
        buildCommandResultEnvelope({
          command: "app:hidden-result",
          resultSchema: Schema.Struct({ nested: Schema.Struct({ value: Schema.String }) }),
          outcome,
          redactor: identityRedactor,
        }),
      ),
    ),
  );

  // Then
  expect(envelope).toMatchObject({
    ok: false,
    error: { _tag: "CommandResultEncodeError" },
  });
  expect(getterCalls).toBe(0);
});

test("projects only plain descriptor-safe progress data", () => {
  // Given
  let toJsonCalls = 0;
  const withToJson = {
    _tag: "stdout",
    chunk: "not-read",
    toJSON: () => {
      toJsonCalls += 1;
      return {};
    },
  };
  class ExoticFrame {
    readonly _tag = "stderr";
    readonly chunk = "not-read";
  }

  // When
  const projected = projectMcpProgressFrame({ _tag: "stdout", chunk: "hello", service: "web" });
  const toJsonFailure = () => projectMcpProgressFrame(withToJson);
  const exoticFailure = () => projectMcpProgressFrame(new ExoticFrame());

  // Then
  expect(projected).toEqual({ _tag: "stdout", chunk: "hello", service: "web" });
  expect(toJsonFailure).toThrow(McpTransportError);
  expect(exoticFailure).toThrow(McpTransportError);
  expect(toJsonCalls).toBe(0);
});
