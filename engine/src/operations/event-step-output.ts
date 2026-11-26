/**
 * Narration and failure tails run every stream through the same output line redactor as build
 * output (value layer over raw bytes, framing, then the bounded line-stream),
 * so a secret that spans lines is masked in narration and in the tail alike.
 * Collected output is redacted when it is presented; output a live sink already
 * delivered is redacted as it streams, keeping only a bounded tail.
 */
import { type OutputRedactionScope, createOutputLineRedactor } from "@lando/redaction/line-stream";
import { RedactionService, createPayloadValues } from "@lando/redaction/service";
import { StreamFrameSink, type StreamFrameSinkShape } from "@lando/sdk/services";
import { Effect, Option } from "effect";

const OUTPUT_TAIL_LENGTH = 4_000;
const encoder = new TextEncoder();

/** Per-stream text for a failure tail; each stream is already redacted. */
export interface EventStepOutputTail {
  readonly stdout: string;
  readonly stderr: string;
}

export const redactCollectedOutput = (scope: OutputRedactionScope, text: string): readonly string[] => {
  const output = createOutputLineRedactor(scope);
  return [...output.write(encoder.encode(text)), ...output.end()];
};

/** The redacted failure tail: streamed output when a live sink took it, else the collected streams. */
export const failureOutputTail = (
  scope: OutputRedactionScope,
  collected: EventStepOutputTail,
  streamed: EventStepOutputTail | undefined,
): string => {
  const { stdout, stderr } = streamed ?? {
    stdout: redactCollectedOutput(scope, collected.stdout).join("\n"),
    stderr: redactCollectedOutput(scope, collected.stderr).join("\n"),
  };
  return `${stdout}${stdout.length > 0 && stderr.length > 0 ? "\n" : ""}${stderr}`.slice(-OUTPUT_TAIL_LENGTH);
};

const appendTailText = (current: string, released: readonly string[]): string => {
  if (released.length === 0) return current;
  const next = released.join("\n");
  const joined = current.length === 0 ? next : `${current}\n${next}`;
  return joined.slice(-OUTPUT_TAIL_LENGTH);
};

/**
 * Run `effect` with a tee in front of the live sink that keeps a bounded,
 * redacted tail of each stream, because the result then holds none of that
 * output. Without a live sink the effect runs unchanged.
 */
export const withStreamedTail = Effect.fnUntraced(function* <A extends object, E, R>(
  redactor: OutputRedactionScope["redactor"],
  effect: Effect.Effect<A, E, R>,
): Effect.fn.Return<A & { readonly streamedTail?: EventStepOutputTail }, E, R> {
  const live = yield* Effect.serviceOption(StreamFrameSink);
  if (Option.isNone(live)) return yield* effect;
  const redaction = yield* Effect.serviceOption(RedactionService);
  const payloadValues = Option.isSome(redaction)
    ? yield* redaction.value.payloadValues()
    : createPayloadValues([]);
  const tail = { stdout: "", stderr: "" };
  const streams = {
    stdout: createOutputLineRedactor({ redactor, payloadValues }),
    stderr: createOutputLineRedactor({ redactor, payloadValues }),
  };
  const tee: StreamFrameSinkShape = {
    emit: (frame) =>
      Effect.sync(() => {
        const bytes =
          frame.kind === "record"
            ? encoder.encode(`${frame.chunk}\n`)
            : typeof frame.chunk === "string"
              ? encoder.encode(frame.chunk)
              : frame.chunk;
        tail[frame._tag] = appendTailText(tail[frame._tag], streams[frame._tag].write(bytes));
      }).pipe(Effect.andThen(live.value.emit(frame))),
  };
  const result = yield* effect.pipe(Effect.provideService(StreamFrameSink, tee));
  for (const kind of ["stdout", "stderr"] as const) {
    tail[kind] = appendTailText(tail[kind], streams[kind].end());
  }
  return { ...result, streamedTail: tail };
});
