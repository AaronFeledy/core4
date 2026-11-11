import { buildCommandResultEnvelope, taggedErrorJson } from "@lando/sdk/command-result";
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
      const redacted =
        key === "_tag" ? value : yield* redactBoundedJsonValue(value, redactor, "MCP tool failure");
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

export const commandResult = Effect.fnUntraced(function* (
  result: McpDispatchResult,
  context: { readonly redactor: Redactor; readonly notice?: McpToolNotice },
) {
  const text = yield* stringifyBoundedJson(result.envelope, "MCP tool result");
  return new McpSchema.CallToolResult({
    content: [{ type: "text", text }, ...noticeContent(context.notice, context.redactor)],
    structuredContent: result.envelope,
    isError: !result.ok,
  });
});
