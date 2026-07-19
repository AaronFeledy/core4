/**
 * Machine (JSON/stream) result emitters for the command boundary.
 *
 * These are the byte-stable machine-output consumers: they encode a command's
 * result envelope, stream result frame, buffered lifecycle events, and streamed
 * stdout/stderr frames through the single `result-encode` seam and write them as
 * result lines. Behavior is frozen — the emitted bytes are a contract. The
 * orchestrator builds one emitter bundle per command run.
 */
import { Effect, Option } from "effect";

import { EventService } from "@lando/sdk/services";

import { RedactionService } from "../redaction/service.ts";
import type { CommandWarningsShape } from "./command-warnings.ts";
import { writeResultLine } from "./renderer-output.ts";
import {
  encodeCommandResult,
  encodeStreamEventFrame,
  encodeStreamResultFrame,
  encodeStreamStderrFrame,
  encodeStreamStdoutFrame,
} from "./result-encode.ts";

export interface StreamOutputFrame {
  readonly _tag: "stdout" | "stderr";
  readonly chunk: string;
  readonly service?: string;
  readonly source?: string;
}

type CommandResultOutcome = Parameters<typeof encodeCommandResult>[0]["outcome"];

export interface MachineResultEmitterDeps<A> {
  readonly command: string;
  readonly resultSchema: Parameters<typeof encodeCommandResult>[0]["resultSchema"];
  readonly commandWarnings: CommandWarningsShape;
  readonly streamFrames?: (value: A) => ReadonlyArray<StreamOutputFrame>;
  readonly redactionTokens?: (value: A) => ReadonlyArray<string>;
}

export const makeMachineResultEmitters = <A>(deps: MachineResultEmitterDeps<A>) => {
  const { command, resultSchema, commandWarnings } = deps;
  const jsonRedactor = (redactionTokens: ReadonlyArray<string> = []) =>
    Effect.gen(function* () {
      const redaction = yield* Effect.serviceOption(RedactionService);
      if (redaction._tag === "Some")
        return yield* redaction.value.forProfile("secrets", {
          sourceEnv: process.env,
          redactionTokens,
        });
      return { redactString: (text: string) => text, redactValue: (value: unknown) => value };
    });
  const emitJsonResult = (outcome: CommandResultOutcome) =>
    Effect.gen(function* () {
      const redactor = yield* jsonRedactor();
      const warnings = yield* commandWarnings.list;
      const line = yield* encodeCommandResult({ command, resultSchema, outcome, redactor, warnings });
      yield* writeResultLine(line);
    });
  const emitStreamResult = (outcome: CommandResultOutcome, redactionTokens: ReadonlyArray<string> = []) =>
    Effect.gen(function* () {
      const redactor = yield* jsonRedactor(redactionTokens);
      const warnings = yield* commandWarnings.list;
      const line = yield* encodeStreamResultFrame({
        command,
        resultSchema,
        outcome,
        redactor,
        warnings,
      });
      yield* writeResultLine(line);
    });
  const replayBufferedEvents = (redactionTokens: ReadonlyArray<string> = []) =>
    Effect.gen(function* () {
      const redactor = yield* jsonRedactor(redactionTokens);
      const events = yield* Effect.serviceOption(EventService).pipe(
        Effect.flatMap((service) => (Option.isSome(service) ? service.value.query("*") : Effect.succeed([]))),
      );
      for (const event of events) {
        const line = yield* encodeStreamEventFrame({ event: event._tag, payload: event, redactor });
        yield* writeResultLine(line);
      }
    });
  const emitStreamingSuccess = (value: A) =>
    Effect.gen(function* () {
      const tokens = deps.redactionTokens?.(value) ?? [];
      const redactor = yield* jsonRedactor(tokens);
      for (const frame of deps.streamFrames?.(value) ?? []) {
        const streamFrameOptions = {
          chunk: frame.chunk,
          ...(frame.service === undefined ? {} : { service: frame.service }),
          ...(frame.source === undefined ? {} : { source: frame.source }),
          redactor,
        };
        const line =
          frame._tag === "stdout"
            ? yield* encodeStreamStdoutFrame(streamFrameOptions)
            : yield* encodeStreamStderrFrame(streamFrameOptions);
        yield* writeResultLine(line);
      }
      yield* replayBufferedEvents(tokens);
      yield* emitStreamResult({ _tag: "success", value }, tokens);
    });
  return { jsonRedactor, emitJsonResult, emitStreamResult, replayBufferedEvents, emitStreamingSuccess };
};
