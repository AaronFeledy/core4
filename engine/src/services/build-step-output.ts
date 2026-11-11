import type { EventError, ProviderInternalError } from "@lando/sdk/errors";
import { TaskDetailEvent } from "@lando/sdk/events";
import { makeLineFramer } from "@lando/sdk/log-follow";
import type { AbsolutePath } from "@lando/sdk/schema";
import { type PayloadRedactor, createPayloadRedactor } from "@lando/sdk/secrets";
import type { EventService } from "@lando/sdk/services";
import { type Context, DateTime, Effect } from "effect";

import type { BuildRedaction } from "./build-redaction.ts";
import { openBuildTranscript } from "./build-transcript.ts";

const TAIL_LINES = 20;
const TAIL_CHARS = 4096;
const encoder = new TextEncoder();

export type BuildStepOutputStream = "stdout" | "stderr";

export type BuildStepOutputError = EventError | ProviderInternalError;

export interface BuildStepOutput {
  readonly write: (
    stream: BuildStepOutputStream,
    chunk: Uint8Array,
  ) => Effect.Effect<void, BuildStepOutputError>;
  /** Append a redacted line to the transcript without publishing it or retaining it in the tail. */
  readonly note: (line: string) => Effect.Effect<void, ProviderInternalError>;
  /** Flush held bytes and unterminated lines. Idempotent; the scope finalizer runs it too. */
  readonly end: Effect.Effect<void, BuildStepOutputError>;
  /** Bounded, redacted tail of the published output, or undefined when there is none. */
  readonly tail: () => string | undefined;
}

export interface BuildStepOutputInput {
  readonly events: Pick<Context.Service.Shape<typeof EventService>, "publish">;
  readonly taskId: string;
  readonly transcriptPath: AbsolutePath;
  readonly providerId: string;
  readonly userDataRoot: string;
  readonly redaction: BuildRedaction;
}

interface StreamState {
  readonly payload: PayloadRedactor;
  readonly framer: ReturnType<typeof makeLineFramer>;
}

interface PendingLine {
  readonly stream: BuildStepOutputStream;
  readonly line: string;
}

const makeStreamState = (redaction: BuildRedaction): StreamState => ({
  payload: createPayloadRedactor(redaction.payloadValues),
  framer: makeLineFramer(),
});

export const openBuildStepOutput = Effect.fnUntraced(function* (
  input: BuildStepOutputInput,
): Effect.fn.Return<BuildStepOutput, ProviderInternalError, import("effect").Scope.Scope> {
  const transcript = yield* openBuildTranscript(input.providerId, input.transcriptPath, input.userDataRoot);
  const streams = {
    stdout: makeStreamState(input.redaction),
    stderr: makeStreamState(input.redaction),
  } satisfies Record<BuildStepOutputStream, StreamState>;
  const tail: string[] = [];
  const pending: PendingLine[] = [];
  let ended = false;

  const emit = Effect.fnUntraced(function* (stream: BuildStepOutputStream, line: string) {
    const safe = input.redaction.redactor.redactString(line);
    tail.push(safe);
    if (tail.length > TAIL_LINES) tail.shift();
    yield* transcript.append(encoder.encode(`${safe}\n`));
    yield* input.events.publish(
      TaskDetailEvent.make({
        taskId: input.taskId,
        stream,
        line: safe,
        timestamp: yield* DateTime.now,
      }),
    );
  });

  // Each line leaves the queue only after its emission committed, so an interrupt between two lines
  // of one chunk leaves the rest for the scope finalizer.
  const drain: Effect.Effect<void, BuildStepOutputError> = Effect.suspend(
    (): Effect.Effect<void, BuildStepOutputError> => {
      const head = pending[0];
      if (head === undefined) return Effect.void;
      return Effect.uninterruptible(
        emit(head.stream, head.line).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              pending.shift();
            }),
          ),
        ),
      ).pipe(Effect.andThen(drain));
    },
  );

  const enqueue = (stream: BuildStepOutputStream, lines: ReadonlyArray<string>) => {
    for (const line of lines) pending.push({ stream, line });
  };

  const write: BuildStepOutput["write"] = (stream, chunk) =>
    Effect.suspend(() => {
      if (ended) return Effect.void;
      const state = streams[stream];
      const lines = state.framer.feed(state.payload.write(chunk)).map((line) => line.text);
      enqueue(stream, lines);
      return drain;
    });

  const end: BuildStepOutput["end"] = Effect.uninterruptible(
    Effect.gen(function* () {
      if (ended) return yield* drain;
      ended = true;
      yield* drain;
      for (const stream of ["stdout", "stderr"] as const) {
        const state = streams[stream];
        const flushedPayload = state.framer.feed(state.payload.flush());
        enqueue(
          stream,
          [...flushedPayload, ...state.framer.flush()].map((line) => line.text),
        );
      }
      yield* drain;
    }),
  );

  // Registered after the transcript acquisition so LIFO cleanup drains output before the file closes.
  // A finalizer cannot fail the scope; the explicit `end` call propagates its errors.
  yield* Effect.addFinalizer(() => end.pipe(Effect.ignore));

  const note: BuildStepOutput["note"] = (line) =>
    transcript.append(encoder.encode(`${input.redaction.redactor.redactString(line)}\n`));

  const tailValue = (): string | undefined => {
    if (tail.length === 0) return undefined;
    // Redact the joined tail first so a cross-line pattern matches, then bound the redacted text.
    const redacted = input.redaction.redactor.redactString(tail.join("\n"));
    let bounded = redacted;
    if (bounded.length > TAIL_CHARS) {
      bounded = bounded.slice(bounded.length - TAIL_CHARS);
      const boundary = bounded.indexOf("\n");
      if (boundary >= 0) bounded = bounded.slice(boundary + 1);
    }
    return bounded.length === 0 ? undefined : bounded;
  };

  return { write, note, end, tail: tailValue };
});
