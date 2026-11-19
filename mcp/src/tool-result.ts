import { buildCommandResultEnvelope, structuralRedaction, taggedErrorJson } from "@lando/sdk/command-result";
import { McpToolInputError, McpToolNotAllowedError, McpTransportError } from "@lando/sdk/errors";
import { CommandResultEnvelope, getJsonSchemaWithDeprecations } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import * as McpSchema from "effect/ai/McpSchema";
import { redactBoundedJsonValue, stringifyBoundedJson } from "./bounded-json";
import type { McpDispatchError, McpDispatchResult } from "./dispatch";
import { compactOutputSchema } from "./output-schema";
import type { McpToolPublication } from "./session-catalog";

export interface McpToolNotice extends McpToolPublication {
  readonly appPath: string;
}

// Only the closed MCP dispatch-error union makes its `_tag` public: the tag is a
// schema literal, so it cannot carry user data. A generic tagged error keeps
// ordinary free-text redaction.
const dispatchErrorPolicy = structuralRedaction(
  Schema.Union([McpToolNotAllowedError, McpToolInputError, McpTransportError]),
);

const noticeContent = (notice: McpToolNotice | undefined, redactor: Redactor) => {
  if (notice === undefined || notice.added.length + notice.changed.length === 0) return [];
  const changes = [
    ...(notice.added.length === 0 ? [] : [`Added tools: ${notice.added.join(", ")}.`]),
    ...(notice.changed.length === 0 ? [] : [`Updated tool contracts: ${notice.changed.join(", ")}.`]),
  ];
  return [
    {
      type: "text" as const,
      text: redactor.redactString(
        `Lando advertised tools for app at ${notice.appPath}. ${changes.join(" ")} Your tool list refreshes automatically if your client supports tool list updates. Otherwise, request tools/list to refresh it. Read updated contracts before retrying a rejected call.`,
      ),
    },
  ];
};

export const toolOutputSchema = (resultSchema: Schema.Codec<unknown, unknown>) =>
  Schema.decodeUnknownSync(McpSchema.ToolOutputJson)(
    compactOutputSchema(
      Schema.decodeUnknownSync(Schema.JsonObject)(
        getJsonSchemaWithDeprecations(
          Schema.Struct({
            ...CommandResultEnvelope.fields,
            result: Schema.optionalKey(resultSchema),
          }),
        ),
      ),
    ),
  );

export const rejectionResult = Effect.fnUntraced(function* (
  error: McpDispatchError,
  context: { readonly toolId: string; readonly redactor: Redactor; readonly notice?: McpToolNotice },
) {
  const { redactor } = context;
  const data = taggedErrorJson(error);
  const fields = yield* Effect.forEach(
    Object.entries(data),
    Effect.fnUntraced(function* ([key, value]) {
      const child = dispatchErrorPolicy.child(key, data);
      const redacted = yield* redactBoundedJsonValue(value, redactor, "MCP tool failure", child);
      return [key, redacted] as const;
    }),
  );
  const encoded = yield* buildCommandResultEnvelope({
    command: context.toolId,
    resultSchema: Schema.Unknown,
    outcome: { _tag: "failure", error: Object.fromEntries(fields), additionalErrors: [] },
    redactor,
  });
  const text = yield* stringifyBoundedJson(encoded, "MCP tool failure");
  const envelope = Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(text));
  return new McpSchema.CallToolResult({
    content: [{ type: "text", text }, ...noticeContent(context.notice, redactor)],
    structuredContent: envelope,
    isError: true,
  });
});

export const commandResult = (
  result: McpDispatchResult,
  context: { readonly redactor: Redactor; readonly notice?: McpToolNotice },
): Effect.Effect<McpSchema.CallToolResult> =>
  Effect.succeed(
    new McpSchema.CallToolResult({
      // The dispatch already serialized with the result schema's policy; reusing
      // that text keeps a schema literal or a `SecretRef` descriptor readable.
      content: [{ type: "text", text: result.text }, ...noticeContent(context.notice, context.redactor)],
      structuredContent: result.envelope,
      isError: !result.ok,
    }),
  );
