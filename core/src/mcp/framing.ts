/**
 * MCP progress-frame framing seam.
 *
 * Bridges a command's `StreamFrameSink` emissions onto the `McpTransport`
 * notification channel: each frame is projected to a safe progress shape,
 * bounded-redacted, then handed to the per-request `notify`. `makeStreamFrameSink`
 * is the `StreamFrameSink` service the retained-runtime execution provides for a
 * single in-flight request.
 */
import { type Context, Effect } from "effect";

import { McpTransportError } from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";

import type { StreamFrameSink, StreamFrameSinkFrame } from "../cli/stream-frame-sink.ts";
import { redactBoundedJsonValue } from "./bounded-json.ts";
import type { McpNotify } from "./dispatch.ts";
import { projectMcpProgressFrame } from "./result-inspector.ts";

export const encodeProgressFrame = (
  frame: unknown,
  redactorForFrame: Redactor,
): Effect.Effect<unknown, McpTransportError> =>
  Effect.try({
    try: () => projectMcpProgressFrame(frame),
    catch: (cause) =>
      cause instanceof McpTransportError
        ? cause
        : new McpTransportError({
            message: "MCP progress payload could not be safely inspected.",
            remediation: "Emit a plain stdout or stderr frame with string chunk and service fields.",
          }),
  }).pipe(
    Effect.flatMap((projected) =>
      redactBoundedJsonValue(projected, redactorForFrame, "MCP progress payload"),
    ),
  );

export const makeStreamFrameSink = (
  notify: McpNotify,
  redactorForFrame: Redactor,
): Context.Tag.Service<typeof StreamFrameSink> => ({
  emit: (frame: StreamFrameSinkFrame) =>
    encodeProgressFrame(frame, redactorForFrame).pipe(Effect.flatMap(notify), Effect.orDie),
});
