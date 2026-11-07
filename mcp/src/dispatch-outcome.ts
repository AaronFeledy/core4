/** Rejections and failure envelopes a dispatched call can end with before or instead of running. */
import { type CommandResultOutcome, buildCommandResultEnvelope } from "@lando/sdk/command-result";
import { McpToolNotAllowedError, McpTransportError } from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";
import { Effect, Predicate, Schema } from "effect";

import { redactBoundedJsonValue, stringifyBoundedJson } from "./bounded-json";
import type { OutputCapture } from "./output-capture";

/** The allowlist rejection for `toolId`, naming the session's effective allowlist and its source. */
export const mcpToolNotAllowedError = (
  toolId: string,
  allowlist: { readonly effective: ReadonlySet<string>; readonly allowlistSource: string },
): McpToolNotAllowedError =>
  new McpToolNotAllowedError({
    message: `Tool ${toolId} is not in the effective MCP allowlist.`,
    toolId,
    effectiveAllowlist: [...allowlist.effective].sort((a, b) => a.localeCompare(b)),
    source: allowlist.allowlistSource,
    remediation: `Add ${toolId} to \`mcp.allow\` (or --allow) to expose it as an MCP tool.`,
  });

export const envelopeTag = (envelope: unknown): string | undefined => {
  if (!Predicate.isObject(envelope)) return undefined;
  const error = envelope.error;
  if (!Predicate.isObject(error)) return undefined;
  const tag = error._tag;
  return typeof tag === "string" ? tag : undefined;
};

/** Encode a failed outcome as the redacted, bounded command envelope an MCP client receives. */
export const encodeFailureEnvelope = Effect.fnUntraced(function* (
  command: string,
  outcome: CommandResultOutcome,
  output: { readonly redactor: Redactor; readonly capture: OutputCapture },
): Effect.fn.Return<Schema.Json, McpTransportError> {
  const encoded = yield* buildCommandResultEnvelope({
    command,
    resultSchema: Schema.Unknown,
    outcome,
    redactor: output.redactor,
  });
  const safeEnvelope = yield* redactBoundedJsonValue(encoded, output.redactor, "MCP tool failure");
  if (!Predicate.isObject(safeEnvelope))
    return yield* Effect.fail(
      new McpTransportError({
        message: "MCP failure encoding did not produce an object envelope.",
        remediation: "Return a schema-valid command failure.",
      }),
    );
  const envelope: Schema.Json = JSON.parse(
    yield* stringifyBoundedJson(
      output.capture.fitEnvelope(safeEnvelope, output.redactor),
      "MCP tool failure",
    ),
  );
  return envelope;
});
