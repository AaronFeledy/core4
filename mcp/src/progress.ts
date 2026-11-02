/**
 * MCP progress-frame framing seam.
 *
 * Bridges a command's `StreamFrameSink` emissions onto the MCP server's
 * notification channel: each frame is projected to a safe progress shape,
 * bounded-redacted, then handed to the per-request `notify`. `makeStreamFrameSink`
 * is the `StreamFrameSink` service the retained-runtime execution provides for a
 * single in-flight request.
 */
import { Effect, Semaphore } from "effect";

import { McpTransportError } from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";

import { StreamFrameSink, type StreamFrameSinkFrame } from "@lando/engine/operations/stream-frame-sink";
import { redactBoundedJsonValue } from "./bounded-json";
import type { McpNotify } from "./dispatch";
import { LiveProgress } from "./live-progress";
import { projectLiveProgressInput } from "./live-progress-input";
import { OutputCapture } from "./output-capture";
import { projectMcpProgressFrame } from "./result-inspector";

export const encodeProgressFrame = (
  frame: unknown,
  redactorForFrame: Redactor,
  capture?: OutputCapture,
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
      redactBoundedJsonValue(projected, redactorForFrame, "MCP progress payload").pipe(
        Effect.tap((safe) =>
          Effect.sync(() => capture?.append(projectMcpProgressFrame(safe), projected.chunk)),
        ),
      ),
    ),
  );

export const makeStreamFrameSink = (
  notify: McpNotify,
  redactorForFrame: Redactor,
  payloadValues: () => Iterable<string>,
) => {
  const lock = Semaphore.makeUnsafe(1);
  const capture = new OutputCapture(payloadValues);
  let finished = false;
  const live = new LiveProgress(payloadValues, (frame) =>
    encodeProgressFrame(frame, redactorForFrame, capture).pipe(Effect.flatMap(notify), Effect.orDie),
  );
  const sink = StreamFrameSink.of({
    emit: (frame: StreamFrameSinkFrame) =>
      lock.withPermits(1)(
        Effect.sync(() => {
          if (finished)
            throw new McpTransportError({
              message: "Command output is already finished.",
              remediation: "Join producers before finishing command output.",
            });
          return projectLiveProgressInput(frame);
        }).pipe(Effect.flatMap((projected) => live.emit(projected))),
      ),
  });
  const finish = () =>
    lock.withPermits(1)(
      Effect.suspend(() => {
        if (finished) return Effect.void;
        finished = true;
        return live.flush();
      }),
    );
  return { sink, finish, capture };
};
