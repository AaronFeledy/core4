import { McpToolInputError, McpToolNotAllowedError } from "@lando/sdk/errors";
import { CommandResultEnvelope, getJsonSchemaWithDeprecations } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import * as McpSchema from "effect/ai/McpSchema";
import { redactBoundedJsonValue, stringifyBoundedJson } from "./bounded-json";
import type { McpDispatchError, McpDispatchResult } from "./dispatch";

export const toolOutputSchema = (resultSchema: Schema.Codec<unknown, unknown>) =>
  Schema.decodeUnknownSync(McpSchema.ToolOutputJson)(
    getJsonSchemaWithDeprecations(
      Schema.Struct({
        ...CommandResultEnvelope.fields,
        result: Schema.optionalKey(resultSchema),
      }),
    ),
  );

export const rejectionResult = Effect.fnUntraced(function* (error: McpDispatchError, redactor: Redactor) {
  const data =
    error instanceof McpToolInputError
      ? Schema.encodeSync(McpToolInputError)(error)
      : error instanceof McpToolNotAllowedError
        ? Schema.encodeSync(McpToolNotAllowedError)(error)
        : { _tag: error._tag, message: error.message, remediation: error.remediation };
  const fields = yield* Effect.forEach(
    Object.entries(data),
    Effect.fnUntraced(function* ([key, value]) {
      const redacted =
        key === "_tag" ? value : yield* redactBoundedJsonValue(value, redactor, "MCP tool failure");
      return [key, redacted] as const;
    }),
  );
  const text = yield* stringifyBoundedJson(Object.fromEntries(fields), "MCP tool failure");
  return new McpSchema.CallToolResult({ content: [{ type: "text", text }], isError: true });
});

export const commandResult = Effect.fnUntraced(function* (result: McpDispatchResult) {
  const text = yield* stringifyBoundedJson(result.envelope, "MCP tool result");
  return new McpSchema.CallToolResult({
    content: [{ type: "text", text }],
    structuredContent: result.envelope,
    isError: !result.ok,
  });
});
