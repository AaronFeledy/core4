/**
 * MCP progress-frame framing seam.
 *
 * Bridges a command's `StreamFrameSink` emissions onto the MCP server's
 * notification channel: each frame is projected to a safe progress shape,
 * bounded-redacted, then handed to the per-request `notify`. `makeStreamFrameSink`
 * is the `StreamFrameSink` service the retained-runtime execution provides for a
 * single in-flight request.
 */

import { makeLiveHoldTimer } from "@lando/redaction/live-hold-timer";
import { structuralRedaction } from "@lando/sdk/command-result";
import { McpTransportError } from "@lando/sdk/errors";
import { StreamFrame } from "@lando/sdk/schema";
import type { Redactor, TieredRedactionValues } from "@lando/sdk/secrets";
import { StreamFrameSink, type StreamFrameSinkFrame } from "@lando/sdk/services";
import { Clock, Effect, type Fiber, Scope, Semaphore } from "effect";
import { redactBoundedJsonValue } from "./bounded-json";
import type { McpNotify } from "./dispatch";
import { LiveProgress } from "./live-progress";
import { projectLiveProgressInput } from "./live-progress-input";
import { OutputCapture } from "./output-capture";
import { projectMcpProgressFrame } from "./result-inspector";

const progressPolicy = structuralRedaction(StreamFrame);

export const encodeProgressFrame = (
  frame: unknown,
  redactorForFrame: Redactor,
  capture?: OutputCapture,
  bodyRedactorForFrame = redactorForFrame,
  profileChanged?: boolean,
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
      redactBoundedJsonValue(
        {
          ...projected,
          ...(projected.service === undefined
            ? {}
            : { service: redactorForFrame.redactString(projected.service) }),
          ...(projected.source === undefined
            ? {}
            : { source: redactorForFrame.redactString(projected.source) }),
        },
        bodyRedactorForFrame,
        "MCP progress payload",
        progressPolicy,
      ).pipe(
        Effect.tap((safe) =>
          Effect.sync(() => capture?.append(projectMcpProgressFrame(safe), projected.chunk, profileChanged)),
        ),
      ),
    ),
  );

/**
 * Build the live progress sink for one in-flight MCP request. Output is
 * delivered under one semaphore; a single owned timer sleeps until the
 * earliest held deadline and fails that hold closed, so a quiet producer never
 * stalls progress. `finish` keeps undelivered output for a retry, then
 * interrupts the timer and closes its scope.
 */
export const makeStreamFrameSink = (
  notify: McpNotify,
  redactorForFrame: Redactor,
  payloadValues: () => Iterable<string> | TieredRedactionValues,
  bodyRedactorForFrame = redactorForFrame,
) => {
  const lock = Semaphore.makeUnsafe(1);
  const capture = new OutputCapture(payloadValues, bodyRedactorForFrame);
  const timerScope = Scope.makeUnsafe("sequential");
  let clock: { readonly currentTimeMillisUnsafe: () => number } | undefined;
  let nowMs = 0;
  let finished = false;
  const refreshNow = Effect.gen(function* () {
    if (clock === undefined) clock = yield* Clock.clockWith(Effect.succeed);
    nowMs = clock.currentTimeMillisUnsafe();
  });
  const live = new LiveProgress(
    payloadValues,
    (frame, profileChanged) =>
      encodeProgressFrame(frame, redactorForFrame, capture, bodyRedactorForFrame, profileChanged).pipe(
        Effect.flatMap(notify),
        Effect.orDie,
      ),
    { redactor: bodyRedactorForFrame, now: () => nowMs },
  );

  const delay = makeLiveHoldTimer({
    lock,
    scope: timerScope,
    refreshNow,
    now: () => nowMs,
    deadline: live.deadline,
    expire: Effect.suspend(() => live.expireDue()),
    isFinished: () => finished,
  });

  /** Runs one locked state change, then interrupts a superseded timer outside the lock. */
  const serialized = <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const state: { stale: Fiber.Fiber<void> | undefined } = { stale: undefined };
    const effect = lock.withPermits(1)(
      Effect.gen(function* () {
        const value = yield* body;
        state.stale = yield* delay.schedule();
        return value;
      }),
    );
    return effect.pipe(Effect.ensuring(Effect.suspend(() => delay.interrupt(state.stale))));
  };

  const sink = StreamFrameSink.of({
    emit: (frame: StreamFrameSinkFrame) =>
      serialized(
        Effect.gen(function* () {
          yield* refreshNow;
          if (finished)
            throw new McpTransportError({
              message: "Command output is already finished.",
              remediation: "Join producers before finishing command output.",
            });
          yield* live.emit(projectLiveProgressInput(frame));
        }),
      ),
  });

  const finish = () => {
    let stale: Fiber.Fiber<void> | undefined;
    return lock
      .withPermits(1)(
        Effect.gen(function* () {
          finished = true;
          stale = yield* delay.schedule();
          yield* refreshNow;
          yield* live.flush();
        }),
      )
      .pipe(
        Effect.ensuring(Effect.suspend(() => delay.interrupt(stale))),
        Effect.ensuring(Effect.suspend(() => delay.close())),
      );
  };
  return { sink, finish, capture };
};
