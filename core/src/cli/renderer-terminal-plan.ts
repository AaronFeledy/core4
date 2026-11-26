/**
 * Plans the one terminal document of a settled command run.
 *
 * Planning resolves every redaction, encoding, `--jq`, and formatter outcome
 * and returns a `TerminalDocument` (or nothing for a silent run). It never
 * writes: the run's committer writes the document and sets its status.
 */

import { redactLineText } from "@lando/redaction/line-stream";
import type { RedactionService } from "@lando/redaction/service";
import type { RendererIO } from "@lando/renderer/io";
import { type ProjectedFailure, redactValueWithPolicy, structuralRedaction } from "@lando/sdk/command-result";
import { CommandInputValidationError, JqExpressionError } from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";
import { Cause, Effect, Exit, type Schema } from "effect";
import { commandFailureOutcome, commandInterruptionExitCode } from "./command-interruption";
import type { RenderedOutput, SettledCommand } from "./command-settlement";
import { commandStdioExitCode } from "./command-stdio";
import type { CommandWarningsShape } from "./command-warnings";
import { dimBugReportDetails } from "./diagnostic-text";
import { failureEvidenceLine } from "./failure-evidence";
import { type RenderContext, isDecoratedContext } from "./render-context";
import type { MachineResultEmitters, MachineTerminal } from "./renderer-machine-output";
import type { RendererMode } from "./renderer-selection";
import { type TerminalDocument, diagnosticLine, resultLine, warningMessage } from "./terminal-document";
import { recordCliDefect } from "./terminal-failure";

type FailedCommand<A> = Extract<SettledCommand<A>, { readonly _tag: "failed" }>;
type CompletedCommand<A> = Extract<SettledCommand<A>, { readonly _tag: "completed" }>;

/** The exit status of a typed command failure; the lifecycle `-error` event reports the same code. */
export const commandErrorExitCode = (
  error: unknown,
  failureExitCode: ((error: unknown) => number | undefined) | undefined,
): number =>
  error instanceof JqExpressionError || error instanceof CommandInputValidationError
    ? 2
    : (commandStdioExitCode(error) ?? failureExitCode?.(error) ?? 1);

export interface TerminalPlanDeps<A> {
  readonly redaction: RedactionService["Service"];
  /** The run's output, for the TTY facts of a human failure and the debug channel. */
  readonly io: RendererIO;
  readonly machineTerminal: MachineTerminal<A> | undefined;
  readonly planMachineDocument: MachineResultEmitters<A>["planMachineDocument"];
  /** A live run already delivered its output; its result has nothing more to print. */
  readonly liveOutput: boolean;
  readonly renderContext: RenderContext;
  readonly resultSchema: Schema.Codec<unknown, unknown>;
  readonly commandWarnings: CommandWarningsShape;
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  readonly extraTokens: ReadonlyArray<string>;
  readonly rendererMode: RendererMode;
  readonly signal: AbortSignal | undefined;
  readonly documentOutput: boolean | undefined;
  readonly render: ((value: A, ctx: RenderContext) => string | undefined) | undefined;
  readonly formatError: (failure: ProjectedFailure, redactor: Redactor) => string;
  readonly formatErrorAlreadyRedacted: boolean | undefined;
  readonly redactionTokens: ((value: A) => ReadonlyArray<string>) | undefined;
  readonly errorExitCode: (error: unknown) => number;
  readonly onRedactor: ((redactor: Redactor) => void) | undefined;
  /** The exit the run is traced with: its failure, or the `--jq` failure that replaced its document. */
  readonly setResultExit: (exit: Exit.Exit<unknown, unknown>) => void;
}

/** The human result: the command's captured render, in order, then its rendered text. */
const humanResult = (rendered: RenderedOutput | undefined, text: string | undefined) => [
  ...(rendered ?? []),
  ...(text === undefined ? [] : [resultLine(text)]),
];

export const makeTerminalPlanners = <A>(deps: TerminalPlanDeps<A>) => {
  const { redaction, machineTerminal, sourceEnv, extraTokens, signal } = deps;
  const tokensFor = (value: A): ReadonlyArray<string> => deps.redactionTokens?.(value) ?? [];
  const onJqFailure = (failure: JqExpressionError) => deps.setResultExit(Exit.fail(failure));

  const humanResultText = Effect.fnUntraced(function* (value: A, proxyDefaultDomain: string | undefined) {
    const resultRedaction = { sourceEnv, redactionTokens: [...extraTokens, ...tokensFor(value)] };
    const scope = {
      redactor: yield* redaction.forProfile("secrets", resultRedaction),
      payloadValues: yield* redaction.payloadValues(resultRedaction),
    };
    const { redactor } = scope;
    deps.onRedactor?.(redactor);
    const paintContext: RenderContext = {
      ...deps.renderContext,
      ...(proxyDefaultDomain === undefined ? {} : { proxyDefaultDomain }),
      redact: (text) => redactor.redactString(text),
    };
    // The decoded value takes the type-side policy, so text and machine output apply one
    // secret-named-field rule. Plain text joins a result's line fragments into one stream, so it
    // leaves an unterminated construct open for the line-stream to hold. Decorated output keeps
    // complete-text values, because rewriting an already-styled string can splice `[redacted]`
    // into CSI parameters.
    const plainText = !isDecoratedContext(paintContext);
    const displayValue = redactValueWithPolicy(
      plainText ? { redactString: redactor.redactPrefix } : redactor,
      structuralRedaction(deps.resultSchema, "type"),
      value,
    ) as A;
    const rendered = deps.render?.(displayValue, paintContext);
    if (rendered === undefined || rendered.length === 0) return undefined;
    // A rendered result can carry process output, so plain text gets the same value layer
    // and line-stream as live output instead of one whole-string pass.
    return plainText ? redactLineText(scope, rendered) : rendered;
  });

  const planFailed = Effect.fnUntraced(function* (settled: FailedCommand<A>) {
    const { cause, retained } = settled;
    deps.setResultExit(Exit.failCause(cause));
    const redactor = yield* redaction.forProfile("secrets", { sourceEnv, redactionTokens: extraTokens });
    yield* recordCliDefect(cause, redactor, deps.io);
    const { kind, error, additionalErrors } = commandFailureOutcome(cause, signal);
    const exitCode =
      retained?.exitCode ??
      (Cause.hasInterruptsOnly(cause)
        ? commandInterruptionExitCode(signal)
        : kind === "typed"
          ? deps.errorExitCode(error)
          : 1);
    const evidence = yield* failureEvidenceLine(error);
    const diagnostics = evidence === undefined ? [] : [diagnosticLine(evidence)];
    if (machineTerminal !== undefined) {
      const outcome = { _tag: "failure", error, additionalErrors } as const;
      const plan = yield* deps.planMachineDocument(
        machineTerminal,
        {
          outcome: retained === undefined ? outcome : { ...outcome, value: retained.value },
          redactionTokens: retained === undefined ? [] : tokensFor(retained.value),
          deprecations: settled.deprecations,
        },
        exitCode,
        onJqFailure,
      );
      return { writes: [...plan.lines.map(resultLine), ...diagnostics], exitCode: plan.exitCode };
    }
    const text =
      retained === undefined || deps.liveOutput
        ? undefined
        : yield* humanResultText(retained.value, undefined);
    const formatted = deps.formatError({ error, additionalErrors }, redactor);
    const message = deps.formatErrorAlreadyRedacted === true ? formatted : redactor.redactString(formatted);
    // Failure notices (for example what an incomplete start left in place) follow the error.
    const notices = (yield* deps.commandWarnings.failureNotices).map((notice) =>
      warningMessage(redactor.redactString(notice)),
    );
    return {
      writes: [
        ...humanResult(retained?.rendered, text),
        ...diagnostics,
        diagnosticLine(
          deps.rendererMode === "lando" && deps.io.isTTY === true ? dimBugReportDetails(message) : message,
        ),
        ...notices,
      ],
      exitCode,
    };
  });

  const planCompleted = Effect.fnUntraced(function* (settled: CompletedCommand<A>) {
    const { completed } = settled;
    // A command-owned document replaces the envelope only on a plain success.
    const document = deps.documentOutput === true && completed._tag === "success";
    if (machineTerminal !== undefined && !document) {
      const input = {
        outcome: completed,
        redactionTokens: tokensFor(completed.value),
        deprecations: settled.deprecations,
      };
      // A result that cannot be encoded is reported as the run's failure instead.
      return yield* deps.planMachineDocument(machineTerminal, input, completed.exitCode, onJqFailure).pipe(
        Effect.map(
          (plan): TerminalDocument => ({ writes: plan.lines.map(resultLine), exitCode: plan.exitCode }),
        ),
        Effect.catchCause((cause) =>
          planFailed({ _tag: "failed", cause, deprecations: settled.deprecations }),
        ),
      );
    }
    const text = deps.liveOutput
      ? undefined
      : yield* humanResultText(completed.value, settled.proxyDefaultDomain);
    return { writes: humanResult(settled.rendered, text), exitCode: completed.exitCode };
  });

  /** The settled run's terminal document, or nothing when the run ends silently. */
  const planTerminal = (
    settled: SettledCommand<A>,
  ): Effect.Effect<TerminalDocument | undefined, unknown, RedactionService> => {
    switch (settled._tag) {
      case "silent":
        return Effect.succeed(undefined);
      case "completed":
        return planCompleted(settled);
      case "failed":
        return planFailed(settled);
      default:
        return settled satisfies never;
    }
  };

  return { planTerminal };
};
