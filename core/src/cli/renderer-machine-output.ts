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

import {
  encodeCommandResult,
  encodeStreamEventFrame,
  encodeStreamResultFrame,
  encodeStreamStderrFrame,
  encodeStreamStdoutFrame,
} from "@lando/sdk/command-result";
import { JqExpressionError } from "@lando/sdk/errors";
import { EventService } from "@lando/sdk/services";

import { RedactionService } from "@lando/redaction/service";
import { writeResultLine } from "@lando/renderer/output";
import type { CommandWarningsShape } from "./command-warnings";
import { applyJqToRedactedJsonLine } from "./jq/eval.ts";

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
  readonly projectResultKeys?: readonly string[];
  readonly jqExpression?: string;
}

const isJqExpressionError = (error: unknown): error is JqExpressionError =>
  error instanceof JqExpressionError;

export const makeMachineResultEmitters = <A>(deps: MachineResultEmitterDeps<A>) => {
  const { command, resultSchema, commandWarnings } = deps;
  const projection =
    deps.projectResultKeys === undefined ? {} : { projectResultKeys: deps.projectResultKeys };
  const skipJq = (outcome: CommandResultOutcome): boolean =>
    outcome._tag === "failure" && isJqExpressionError(outcome.error);
  const writeEncodedLine = (line: string, outcome: CommandResultOutcome) =>
    Effect.gen(function* () {
      const expr = deps.jqExpression;
      if (expr === undefined || skipJq(outcome)) {
        yield* writeResultLine(line);
        return;
      }
      const text = yield* Effect.tryPromise({
        try: () => applyJqToRedactedJsonLine(line, expr),
        catch: (error) => {
          if (isJqExpressionError(error)) return error;
          return new JqExpressionError({
            message: "jq expression failed.",
            expression: expr,
            reason: "eval",
            remediation: "Fix the jq expression.",
          });
        },
      });
      yield* writeResultLine(text);
    });
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
  const emitJsonResult = (outcome: CommandResultOutcome, redactionTokens: ReadonlyArray<string> = []) =>
    Effect.gen(function* () {
      const redactor = yield* jsonRedactor(redactionTokens);
      const warnings = yield* commandWarnings.list;
      const line = yield* encodeCommandResult({
        command,
        resultSchema,
        outcome,
        redactor,
        warnings,
        ...projection,
      });
      yield* writeEncodedLine(line, outcome);
    });
  const emitStreamResult = (outcome: CommandResultOutcome, redactionTokens: ReadonlyArray<string> = []) =>
    Effect.gen(function* () {
      const redactor = yield* jsonRedactor(redactionTokens);
      const warnings = yield* commandWarnings.list;
      const args = {
        command,
        resultSchema,
        outcome,
        redactor,
        warnings,
        ...projection,
      };
      // --jq runs on the redacted envelope, not the StreamFrame wrapper.
      const line =
        deps.jqExpression === undefined
          ? yield* encodeStreamResultFrame(args)
          : yield* encodeCommandResult(args);
      yield* writeEncodedLine(line, outcome);
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
