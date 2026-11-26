/**
 * Machine (JSON/YAML/frame) terminal documents for the command boundary.
 *
 * These are the byte-stable machine-output consumers: they encode a command's
 * result envelope, its buffered stdout/stderr frames, report frames, and the
 * terminal result frame through the single `result-encode` seam. Preparing a
 * document resolves every encoding and `--jq` failure before anything is
 * written, so the boundary commits exactly one terminal document. The
 * orchestrator builds one emitter bundle per command run.
 */

import { RedactionService } from "@lando/redaction/service";
import type { CommandResultEnvelopeFormat, EncodeCommandResultOptions } from "@lando/sdk/command-result";
import {
  encodeCommandResult,
  encodeStreamEventFrame,
  encodeStreamResultFrame,
  encodeStreamStderrFrame,
  encodeStreamStdoutFrame,
} from "@lando/sdk/command-result";
import { JqExpressionError } from "@lando/sdk/errors";
import { LandoEvent as LandoEventSchema } from "@lando/sdk/events";
import type { CommandTrace, DeprecationUse } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type { LandoEvent } from "@lando/sdk/services";
import { Effect, Result, type Schema } from "effect";
import type { CommandWarningsShape } from "./command-warnings";
import { applyJqToRedactedJsonLine } from "./jq/eval.ts";
import type { OutputRouting } from "./output-routing";

export interface StreamOutputFrame {
  readonly _tag: "stdout" | "stderr";
  readonly chunk: string;
  readonly service?: string;
  readonly source?: string;
}

type CommandResultOutcome = Parameters<typeof encodeCommandResult>[0]["outcome"];

/**
 * A report command's own `--format=ndjson` form: one event frame per record,
 * then the terminal result frame carrying `result(value)` under `resultSchema`.
 */
export interface NdjsonReport<A> {
  events(value: A): ReadonlyArray<{ readonly event: string; readonly payload: unknown }>;
  readonly resultSchema: Schema.Codec<unknown, unknown>;
  result(value: A): unknown;
}

/** The redacted lines of one report: its event frames, then its result frame. */
export const encodeNdjsonReportLines = Effect.fnUntraced(function* <A>(
  report: NdjsonReport<A>,
  input: Omit<EncodeCommandResultOptions, "resultSchema" | "outcome" | "format" | "output"> & {
    readonly outcome: CommandResultOutcome & { readonly value: A };
  },
) {
  const { outcome, ...envelope } = input;
  const lines: string[] = [];
  for (const { event, payload } of report.events(outcome.value))
    lines.push(yield* encodeStreamEventFrame({ event, payload, redactor: input.redactor }));
  lines.push(
    yield* encodeStreamResultFrame({
      ...envelope,
      resultSchema: report.resultSchema,
      outcome: { ...outcome, value: report.result(outcome.value) },
    }),
  );
  return lines;
});

export interface MachineResultEmitterDeps<A> {
  readonly command: string;
  readonly resultSchema: Parameters<typeof encodeCommandResult>[0]["resultSchema"];
  readonly commandWarnings: CommandWarningsShape;
  readonly streamFrames?: (value: A) => ReadonlyArray<StreamOutputFrame>;
  readonly projectResultKeys?: readonly string[];
  readonly jqExpression?: string;
  /** Envelope serialization for this run. Frames are always JSON. */
  readonly resultFormat?: CommandResultEnvelopeFormat;
  readonly trace?: Effect.Effect<CommandTrace | undefined>;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly extraRedactionTokens?: ReadonlyArray<string>;
  readonly onRedactor?: (redactor: Redactor) => void;
  readonly output?: () => import("@lando/sdk/schema").CommandOutput | undefined;
}

/** The shape of one run's machine terminal document. */
export type MachineTerminal<A> =
  | { readonly _tag: "envelope" }
  /** `buffered`: the data frames come from the result rather than a live sink. */
  | { readonly _tag: "frames"; readonly buffered: boolean }
  | { readonly _tag: "report"; readonly report: NdjsonReport<A> };

/** The machine terminal document a route ends in, or nothing for human output. */
export const machineTerminalFor = <A>(
  routing: OutputRouting,
  report: NdjsonReport<A> | undefined,
): MachineTerminal<A> | undefined => {
  switch (routing.stdout) {
    case "human":
      return undefined;
    case "envelope":
      return { _tag: "envelope" };
    case "frames":
      return { _tag: "frames", buffered: routing.sink !== "live" };
    case "report":
      return report === undefined ? { _tag: "frames", buffered: true } : { _tag: "report", report };
    default:
      return routing satisfies never;
  }
};

export interface MachineTerminalInput<A> {
  readonly outcome: CommandResultOutcome & { readonly value?: A };
  /** The result buffered data frames come from, when the outcome no longer carries it. */
  readonly framesFrom?: A;
  readonly redactionTokens: ReadonlyArray<string>;
  readonly deprecations: ReadonlyArray<DeprecationUse>;
}

/** A planned machine terminal document: its lines, not yet written, and its exit status. */
export interface MachineTerminalPlan {
  readonly lines: ReadonlyArray<string>;
  readonly exitCode: number;
}

export const makeMachineResultEmitters = <A>(deps: MachineResultEmitterDeps<A>) => {
  const { command, resultSchema, commandWarnings } = deps;
  const projection =
    deps.projectResultKeys === undefined ? {} : { projectResultKeys: deps.projectResultKeys };
  // jq consumes the redacted JSON document and owns its own output text, so a
  // run that will actually evaluate jq encodes JSON whatever format was asked.
  // The jq-failure replacement envelope is not passed to jq, so it keeps the
  // requested format.
  const willRunJq = (outcome: CommandResultOutcome): boolean =>
    deps.jqExpression !== undefined &&
    !(outcome._tag === "failure" && outcome.error instanceof JqExpressionError);
  const envelopeFormat = (outcome: CommandResultOutcome): CommandResultEnvelopeFormat =>
    willRunJq(outcome) ? "json" : (deps.resultFormat ?? "json");
  const applyJq = Effect.fnUntraced(function* (line: string, outcome: CommandResultOutcome) {
    const expr = deps.jqExpression;
    if (expr === undefined || !willRunJq(outcome)) return line;
    return yield* Effect.tryPromise({
      try: () => applyJqToRedactedJsonLine(line, expr),
      catch: (error) => {
        if (error instanceof JqExpressionError) return error;
        return new JqExpressionError({
          message: "jq expression failed.",
          expression: expr,
          reason: "eval",
          remediation: "Fix the jq expression.",
        });
      },
    });
  });
  const jsonRedactor = Effect.fnUntraced(function* (redactionTokens: ReadonlyArray<string> = []) {
    const redaction = yield* RedactionService;
    const redactor = yield* redaction.forProfile("secrets", {
      sourceEnv: deps.sourceEnv ?? process.env,
      redactionTokens: [...(deps.extraRedactionTokens ?? []), ...redactionTokens],
    });
    deps.onRedactor?.(redactor);
    return redactor;
  });
  const encodeEventFrame = (event: LandoEvent, redactor: Redactor) =>
    encodeStreamEventFrame({
      event: event._tag,
      payload: event,
      redactor,
      payloadSchema: LandoEventSchema,
    });
  const encodeDataFrames = Effect.fnUntraced(function* (value: A, redactor: Redactor) {
    const lines: string[] = [];
    for (const frame of deps.streamFrames?.(value) ?? []) {
      const streamFrameOptions = {
        chunk: frame.chunk,
        ...(frame.service === undefined ? {} : { service: frame.service }),
        ...(frame.source === undefined ? {} : { source: frame.source }),
        redactor,
      };
      lines.push(
        frame._tag === "stdout"
          ? yield* encodeStreamStdoutFrame(streamFrameOptions)
          : yield* encodeStreamStderrFrame(streamFrameOptions),
      );
    }
    return lines;
  });
  /**
   * Every line of the terminal document, encoded and jq-filtered but not yet
   * written. A failure here means nothing was written.
   */
  const prepareTerminal = Effect.fnUntraced(function* (
    terminal: MachineTerminal<A>,
    input: MachineTerminalInput<A>,
  ): Effect.fn.Return<ReadonlyArray<string>, unknown, RedactionService> {
    const { outcome } = input;
    const redactor = yield* jsonRedactor(input.redactionTokens);
    const warnings = yield* commandWarnings.list;
    const trace = deps.trace === undefined ? undefined : yield* deps.trace;
    const envelope = {
      command,
      redactor,
      warnings,
      deprecations: input.deprecations,
      ...(trace === undefined ? {} : { trace }),
      ...projection,
    };
    switch (terminal._tag) {
      case "envelope": {
        const output = deps.output?.();
        const line = yield* encodeCommandResult({
          ...envelope,
          resultSchema,
          outcome,
          ...(output === undefined ? {} : { output }),
          format: envelopeFormat(outcome),
        });
        return [yield* applyJq(line, outcome)];
      }
      case "frames": {
        const source = input.framesFrom ?? outcome.value;
        const data =
          terminal.buffered && source !== undefined ? yield* encodeDataFrames(source, redactor) : [];
        // --jq runs on the redacted envelope, not the StreamFrame wrapper.
        const args = { ...envelope, resultSchema, outcome };
        const result = willRunJq(outcome)
          ? yield* applyJq(yield* encodeCommandResult({ ...args, format: "json" }), outcome)
          : yield* encodeStreamResultFrame(args);
        return [...data, result];
      }
      case "report": {
        const value = outcome.value;
        if (value === undefined)
          return [yield* encodeStreamResultFrame({ ...envelope, resultSchema, outcome })];
        return yield* encodeNdjsonReportLines(terminal.report, {
          ...envelope,
          outcome: { ...outcome, value },
        });
      }
      default:
        return terminal satisfies never;
    }
  });
  /**
   * Plans the one terminal document. Every encoding and `--jq` failure is
   * resolved here, before anything is written. A `--jq` failure replaces the
   * document with its own failure and exit 2; `onJqFailure` runs before the
   * replacement is encoded, so a trace it carries already records the failure.
   */
  const planMachineDocument = Effect.fnUntraced(function* (
    terminal: MachineTerminal<A>,
    input: MachineTerminalInput<A>,
    exitCode: number,
    onJqFailure: (failure: JqExpressionError) => void,
  ): Effect.fn.Return<MachineTerminalPlan, unknown, RedactionService> {
    const prepared = yield* prepareTerminal(terminal, input).pipe(Effect.result);
    if (Result.isSuccess(prepared)) return { lines: prepared.success, exitCode };
    if (!(prepared.failure instanceof JqExpressionError)) return yield* Effect.fail(prepared.failure);
    onJqFailure(prepared.failure);
    // The data already produced stays; only the result is replaced.
    const { value } = input.outcome;
    const lines = yield* prepareTerminal(terminal, {
      ...input,
      outcome: { _tag: "failure", error: prepared.failure, additionalErrors: [] },
      ...(value === undefined ? {} : { framesFrom: value }),
    });
    return { lines, exitCode: 2 };
  });
  return { jsonRedactor, encodeEventFrame, planMachineDocument };
};

export type MachineResultEmitters<A> = ReturnType<typeof makeMachineResultEmitters<A>>;
