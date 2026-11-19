import { type OutputLineRedactor, createOutputLineRedactor } from "@lando/redaction/line-stream";
import type { EventError, ProviderInternalError } from "@lando/sdk/errors";
import { TaskDetailEvent } from "@lando/sdk/events";
import { LOG_LINE_TRUNCATED_MARKER } from "@lando/sdk/log-follow";
import type { AbsolutePath } from "@lando/sdk/schema";
import type { EventService } from "@lando/sdk/services";
import { type Context, DateTime, Effect } from "effect";

import type { BuildRedaction } from "./build-redaction.ts";
import { openBuildTranscript } from "./build-transcript.ts";

const TAIL_LINES = 20;
const TAIL_CHARS = 4096;
const DISPLAY_LINE_CHARS = 512;
const encoder = new TextEncoder();

/** Bound one line for display; the transcript keeps the full, redacted line. */
const truncateForDisplay = (line: string): string => {
  if (line.length <= DISPLAY_LINE_CHARS) return line;
  let end = DISPLAY_LINE_CHARS;
  const last = line.charCodeAt(end - 1);
  // Never split a surrogate pair: the published line stays valid text.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${line.slice(0, end)}${LOG_LINE_TRUNCATED_MARKER}`;
};

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

interface PendingLine {
  readonly stream: BuildStepOutputStream;
  readonly line: string;
}

export const openBuildStepOutput = Effect.fnUntraced(function* (
  input: BuildStepOutputInput,
): Effect.fn.Return<BuildStepOutput, ProviderInternalError, import("effect").Scope.Scope> {
  const transcript = yield* openBuildTranscript(input.providerId, input.transcriptPath, input.userDataRoot);
  const streams = {
    stdout: createOutputLineRedactor(input.redaction),
    stderr: createOutputLineRedactor(input.redaction),
  } satisfies Record<BuildStepOutputStream, OutputLineRedactor>;
  const tail: string[] = [];
  const pending: PendingLine[] = [];
  let ended = false;

  const emit = Effect.fnUntraced(function* (stream: BuildStepOutputStream, safe: string) {
    const displayed = truncateForDisplay(safe);
    tail.push(displayed);
    if (tail.length > TAIL_LINES) tail.shift();
    yield* transcript.append(encoder.encode(`${safe}\n`));
    yield* input.events.publish(
      TaskDetailEvent.make({
        taskId: input.taskId,
        stream,
        line: displayed,
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
      enqueue(stream, streams[stream].write(chunk));
      return drain;
    });

  const end: BuildStepOutput["end"] = Effect.uninterruptible(
    Effect.gen(function* () {
      if (ended) return yield* drain;
      ended = true;
      yield* drain;
      for (const stream of ["stdout", "stderr"] as const) enqueue(stream, streams[stream].end());
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
    // Every retained line is already safe; bound the joined text without re-redacting it.
    let bounded = tail.join("\n");
    if (bounded.length > TAIL_CHARS) {
      bounded = bounded.slice(bounded.length - TAIL_CHARS);
      const boundary = bounded.indexOf("\n");
      if (boundary >= 0) bounded = bounded.slice(boundary + 1);
    }
    return bounded.length === 0 ? undefined : bounded;
  };

  return { write, note, end, tail: tailValue };
});
