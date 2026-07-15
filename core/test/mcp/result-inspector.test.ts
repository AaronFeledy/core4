import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { buildCommandResultEnvelope, identityRedactor } from "../../src/cli/result-encode.ts";
import { inspectMcpCommandOutcome } from "../../src/mcp/result-inspector.ts";

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
