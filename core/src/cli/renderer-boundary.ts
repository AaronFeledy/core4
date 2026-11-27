/**
 * The CLI command boundary: runs one command and writes exactly one terminal
 * document with one exit status.
 *
 * `runWithRendererHandling` creates the run's single terminal committer, runs
 * the command in its runtime scope (`renderer-command-runner.ts`), plans the
 * settled run's document (`renderer-terminal-plan.ts`), and commits it. A
 * failure outside that path is planned by `planTerminalFailure` and committed
 * through the same committer, which writes nothing once a document was handed
 * to it.
 */

import { RedactionService, makeRedactionOwner } from "@lando/redaction/service";
import {
  type RendererIO,
  createStdioRendererIO,
  isStdioRendererIO,
  onStdioBrokenPipe,
  withStdioTerminalNewlines,
} from "@lando/renderer/io";
import * as RendererOutput from "@lando/renderer/output";
import { writeDiagnosticLine } from "@lando/renderer/output";
import { layerPlainService, makePlainRenderer } from "@lando/renderer/runtime";
import type { CompletedCommandResult, ProjectedFailure } from "@lando/sdk/command-result";
import type { CommandCompletion, StreamFrameSchema } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type { EventService, Renderer } from "@lando/sdk/services";
import { Cause, Effect, ErrorReporter, Exit, Layer, References, Schema, Tracer } from "effect";
import type { CliInvocationContext } from "../runtime/invocation-context";
import { makeChildOutputPolicy } from "./child-output.ts";
import { type CliInvocationSnapshot, newInvocationId } from "./command-lifecycle";
import { CommandPayloadStdout, machineOutputOnStderr } from "./command-payload-stdout";
import { makeStage, withStageParent } from "./command-stage";
import { type CommandTraceCapture, formatCommandTrace } from "./command-tracer";
import { withCommandTracing } from "./command-tracing";
import { CommandWarnings, makeCommandWarnings } from "./command-warnings";
import { DEFAULT_RESULT_FORMAT, type ResultFormat } from "./format-flags";
import { withInvocationServices } from "./invocation-services";
import { resolveOutputRouting } from "./output-routing";
import type { RenderContext } from "./render-context";
import { type RunOutput, runCommandInScope } from "./renderer-command-runner";
import {
  type NdjsonReport,
  type StreamOutputFrame,
  machineTerminalFor,
  makeMachineResultEmitters,
} from "./renderer-machine-output";
import type { RendererMode } from "./renderer-selection";
import { commandErrorExitCode, makeTerminalPlanners } from "./renderer-terminal-plan";
import { ResultTerminal } from "./result-terminal";
import { type TerminalCommitter, makeTerminalCommitter } from "./terminal-document";
import { planTerminalFailure, recordCliDefect } from "./terminal-failure";
import { type TraceSelection, activeTrace } from "./trace-selection";

export {
  type RenderContext,
  contextAllowsHyperlinks,
  isDecoratedContext,
  summaryPaintOptions,
} from "./render-context";
export {
  type ResolveCliDeprecationWarningsOptions,
  type ResolveCliDeprecationWarningsResult,
  resolveCliDeprecationWarnings,
} from "./renderer-deprecations";
export type { StreamOutputFrame } from "./renderer-machine-output";
export {
  type ConfigCliGlobals,
  type ResolveCliRendererModeOptions,
  readConfigCliGlobals,
  resolveCliRendererMode,
} from "./renderer-mode-resolution";

export interface RunWithRendererHandlingOptions<A, R, RE> {
  readonly runtime: Layer.Layer<Exclude<R, EventService | Renderer>, RE>;
  readonly rendererMode: RendererMode;
  readonly resultFormat?: ResultFormat;
  readonly command?: string;
  readonly invocation?: CliInvocationSnapshot;
  readonly resultSchema?: Schema.Codec<unknown, unknown>;
  readonly streaming?: StreamFrameSchema;
  readonly streamingMode?: "live";
  readonly streamFrames?: (value: A) => ReadonlyArray<StreamOutputFrame>;
  /** A report command's own `--format=ndjson` frames. */
  readonly ndjsonReport?: NdjsonReport<NoInfer<A>>;
  readonly redactionTokens?: (value: A) => ReadonlyArray<string>;
  readonly projectResultKeys?: readonly string[];
  readonly jqExpression?: string;
  /** Resolved `LandoCommandSpec.documentOutput` match for this invocation. */
  readonly documentOutput?: boolean;
  readonly payloadStdout?: boolean;
  readonly io?: RendererIO;
  readonly context?: CliInvocationContext;
  readonly deprecationWarnings?: boolean;
  readonly suppressDeprecationDiagnostics?: boolean;
  readonly suppressInterruptionDiagnostics?: boolean;
  readonly signal?: AbortSignal;
  readonly render?: (value: A, ctx: RenderContext) => string | undefined;
  /** A human render that writes through the `Renderer`; its output is captured into the terminal document. */
  readonly renderEffect?: (completed: CompletedCommandResult<A>) => Effect.Effect<void, unknown, R>;
  readonly completion?: (value: A) => CommandCompletion;
  readonly failureExitCode?: (error: unknown) => number | undefined;
  readonly formatError: (failure: ProjectedFailure, redactor: Redactor) => string;
  /**
   * The formatter already redacts every field it prints with the supplied
   * redactor. The boundary must then not scan the assembled report as free
   * text: the secret-assignment scanner would mask a diagnostic label such as
   * `commandToken` and hide the remediation the report exists to carry.
   */
  readonly formatErrorAlreadyRedacted?: boolean;
  readonly setExitCode?: (code: number) => void;
  /**
   * Records the command's spans with this tracer. Without one, the CLI keeps
   * `References.TracerEnabled` false and records nothing.
   */
  readonly tracer?: Tracer.Tracer;
  readonly trace?: TraceSelection;
  readonly traceCapture?: CommandTraceCapture;
  readonly traceDisplay?: boolean;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly extraRedactionTokens?: ReadonlyArray<string>;
}

const EmptyCommandResultSchema = Schema.Struct({});

/**
 * A broken stdio pipe interrupts the run: the reader is gone, so nothing more
 * is written and the process broken-pipe policy owns the exit status (141).
 */
const watchBrokenPipe = () => {
  let broken = false;
  const interruptOnBreak = Effect.callback<never>((resume) => {
    const unsubscribe = onStdioBrokenPipe(() => {
      broken = true;
      unsubscribe();
      resume(Effect.interrupt);
    });
    return Effect.sync(unsubscribe);
  });
  return { broken: () => broken, interruptOnBreak };
};

/** What one `runWithRendererHandling` call shares across its tracing pass and its fallbacks. */
interface BoundaryRun {
  readonly redaction: RedactionService["Service"];
  readonly output: RunOutput;
  readonly committer: TerminalCommitter;
  readonly pipe: ReturnType<typeof watchBrokenPipe>;
}

const resolveRunOutput = <A, R, RE>(
  options: RunWithRendererHandlingOptions<A, R, RE>,
  sourceEnv: Readonly<Record<string, string | undefined>>,
): RunOutput => {
  const routing = resolveOutputRouting({
    rendererMode: options.rendererMode,
    format: options.resultFormat ?? DEFAULT_RESULT_FORMAT,
    frames: options.streaming !== undefined,
    live: options.streamingMode === "live",
    report: options.ndjsonReport !== undefined,
  });
  const machineStdout = routing.stdout !== "human";
  const payloadStdout = options.payloadStdout === true && machineStdout;
  const humanChildOutput = !machineStdout && options.rendererMode !== "json";
  const realIO = withStdioTerminalNewlines(
    options.io ?? createStdioRendererIO(undefined, undefined, undefined, { env: sourceEnv }),
    humanChildOutput,
  );
  const io = payloadStdout ? machineOutputOnStderr(realIO) : realIO;
  return { routing, realIO, io, machineStdout, payloadStdout, humanChildOutput };
};

/**
 * Commits the failure document for a failure outside the run's own planning,
 * unless the run already handed a document to the committer.
 */
const commitFallback = <A, R, RE>(
  cause: Cause.Cause<unknown>,
  options: RunWithRendererHandlingOptions<A, R, RE>,
  run: BoundaryRun,
  redactor: Redactor,
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* recordCliDefect(cause, redactor, run.output.io);
      if (run.committer.attempted()) return;
      yield* run.committer.commit(yield* planTerminalFailure(cause, options, redactor));
    }).pipe(Effect.provide(layerPlainService(run.output.io))),
  );

export const runWithRendererHandling = async <A, E, R, RE>(
  effect: Effect.Effect<A, E, R>,
  options: RunWithRendererHandlingOptions<A, R, RE>,
): Promise<void> => {
  const owner = makeRedactionOwner();
  const sourceEnv = { ...(options.sourceEnv ?? options.context?.env ?? process.env) };
  const handlingOptions = {
    ...options,
    sourceEnv,
    ...(options.context === undefined
      ? {}
      : {
          io: options.io ?? options.context.io,
          setExitCode: options.setExitCode ?? options.context.setExitCode,
        }),
  };
  try {
    const output = resolveRunOutput(handlingOptions, sourceEnv);
    const redactor = await Effect.runPromise(owner.service.forProfile("secrets", { sourceEnv }));
    const pipe = watchBrokenPipe();
    const committer = makeTerminalCommitter({
      signal: handlingOptions.signal,
      setExitCode: handlingOptions.setExitCode,
      brokenPipe: pipe.broken,
      recordDefect: (cause) => recordCliDefect(cause, redactor, output.io),
    });
    const run: BoundaryRun = { redaction: owner.service, output, committer, pipe };
    try {
      await runInvocation(effect, handlingOptions, run);
    } catch (cause) {
      await commitFallback(Cause.isCause(cause) ? cause : Cause.die(cause), handlingOptions, run, redactor);
    }
  } finally {
    owner.dispose();
  }
};

const runInvocation = async <A, E, R, RE>(
  effect: Effect.Effect<A, E, R>,
  options: RunWithRendererHandlingOptions<A, R, RE>,
  run: BoundaryRun,
): Promise<void> => {
  const selection = options.trace ?? activeTrace();
  if (options.tracer === undefined && selection?.enabled === true) {
    return withCommandTracing(
      selection,
      (capture, redactionTokens) =>
        runInvocation(
          effect,
          {
            ...options,
            tracer: capture.tracer,
            traceCapture: capture,
            traceDisplay: selection.display,
            sourceEnv: selection.env,
            extraRedactionTokens: redactionTokens,
          },
          run,
        ),
      options.invocation?.flags,
      run.redaction,
    );
  }
  const { landoRenderer } = await import("./renderer/bundled-renderers");
  const { output, redaction, committer } = run;
  const { routing, io, realIO, machineStdout } = output;
  const sourceEnv = options.sourceEnv ?? process.env;
  const extraTokens = options.extraRedactionTokens ?? [];
  const redactionLayer = Layer.succeed(RedactionService, redaction);
  const rendererLayer = RendererOutput.layerServiceForMode(options.rendererMode, landoRenderer, io);
  const commandWarnings = makeCommandWarnings(machineStdout);
  const childOutput = makeChildOutputPolicy({
    native: isStdioRendererIO(realIO) && output.humanChildOutput,
    // Children inherit the host stdin unless the invocation supplies its own.
    stdin: isStdioRendererIO(realIO) || realIO.stdin === undefined,
    stream: output.humanChildOutput ? () => RendererOutput.makeStreamFrameSink("text") : undefined,
  });
  const commandLayer = Layer.mergeAll(
    options.runtime.pipe(Layer.provide(redactionLayer)),
    rendererLayer,
    Layer.succeed(CommandWarnings, commandWarnings),
    redactionLayer,
    ...(output.payloadStdout
      ? [Layer.succeed(CommandPayloadStdout, makePlainRenderer(realIO).output.stdout)]
      : []),
  ) as Layer.Layer<R, RE>;
  const command = options.command ?? "cli:unknown";
  // Resolve the invocation id once so the root span and lifecycle events agree.
  const invocation =
    options.invocation === undefined
      ? undefined
      : { ...options.invocation, invocationId: options.invocation.invocationId ?? newInvocationId() };
  const stages = { init: makeStage("init"), render: makeStage("render", true) };
  let resultExit: Exit.Exit<unknown, unknown> = Exit.void;
  const setResultExit = (exit: Exit.Exit<unknown, unknown>) => {
    resultExit = exit;
  };
  const capture = options.traceCapture;
  const finishTrace =
    capture === undefined
      ? undefined
      : Effect.gen(function* () {
          yield* stages.render.end(resultExit);
          return yield* capture.finish(resultExit);
        });
  const resultSchema = options.resultSchema ?? EmptyCommandResultSchema;
  const emitters = makeMachineResultEmitters<A>({
    command,
    resultSchema,
    output: childOutput.output,
    commandWarnings,
    sourceEnv,
    extraRedactionTokens: extraTokens,
    ...(capture === undefined ? {} : { onRedactor: capture.setRedactor }),
    ...(finishTrace === undefined ? {} : { trace: finishTrace }),
    ...(options.streamFrames === undefined ? {} : { streamFrames: options.streamFrames }),
    ...(options.projectResultKeys === undefined ? {} : { projectResultKeys: options.projectResultKeys }),
    ...(options.jqExpression === undefined ? {} : { jqExpression: options.jqExpression }),
    ...(routing.stdout === "envelope" ? { resultFormat: routing.serialization } : {}),
  });
  const errorExitCode = (error: unknown) => commandErrorExitCode(error, options.failureExitCode);
  const renderContext: RenderContext = {
    mode: options.rendererMode,
    format: options.resultFormat ?? DEFAULT_RESULT_FORMAT,
    columns: io.stdoutColumns,
    isTTY: io.stdoutIsTTY === true,
    noColor: io.noColor === true,
  };
  const { planTerminal } = makeTerminalPlanners<A>({
    redaction,
    io,
    machineTerminal: machineTerminalFor(routing, options.ndjsonReport),
    planMachineDocument: emitters.planMachineDocument,
    liveOutput: routing.sink === "live",
    renderContext,
    resultSchema,
    commandWarnings,
    sourceEnv,
    extraTokens,
    rendererMode: options.rendererMode,
    signal: options.signal,
    documentOutput: options.documentOutput,
    render: options.render,
    formatError: options.formatError,
    formatErrorAlreadyRedacted: options.formatErrorAlreadyRedacted,
    redactionTokens: options.redactionTokens,
    errorExitCode,
    onRedactor: capture?.setRedactor,
    setResultExit,
  });
  const program = Effect.gen(function* () {
    const initSpan = yield* stages.init.start;
    const settled = yield* runCommandInScope(
      effect,
      {
        options,
        command,
        invocation,
        output,
        commandLayer,
        childOutput,
        commandWarnings,
        landoRenderer,
        stages,
        brokenPipe: run.pipe.broken,
        frameRedactor: emitters.jsonRedactor(),
        encodeEventFrame: emitters.encodeEventFrame,
        errorExitCode,
        onCommandExit: setResultExit,
      },
      initSpan,
    );
    const renderSpan = yield* stages.render.start;
    const document = yield* withStageParent(planTerminal(settled), renderSpan);
    if (document !== undefined) yield* committer.commit(document);
  });
  const rootAttributes = {
    "lando.command.id": command,
    ...(invocation === undefined ? {} : { "lando.invocation.id": invocation.invocationId }),
  };
  const tracedProgram = Effect.useSpan(
    `lando ${command}`,
    { root: true, attributes: rootAttributes },
    (span) =>
      withStageParent(
        program.pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              yield* stages.init.end(exit);
              yield* stages.render.end(resultExit);
              if (capture !== undefined) yield* capture.finish(Exit.isFailure(exit) ? exit : resultExit);
            }),
          ),
        ),
        span,
      ),
  );
  // Installed so command defects reach ErrorReporter. Display stays on formatError,
  // which is the bug-report renderer for pre-command failures.
  const reporter = ErrorReporter.make(() => undefined);
  const diagnosedProgram = withInvocationServices(
    Effect.raceFirst(run.pipe.interruptOnBreak, tracedProgram).pipe(
      Effect.provideService(ResultTerminal, {
        isTTY: renderContext.isTTY,
        columns: renderContext.columns,
        noColor: renderContext.noColor,
      }),
      Effect.withErrorReporting({ defectsOnly: true }),
      Effect.provide(Layer.mergeAll(rendererLayer, redactionLayer, ErrorReporter.layer([reporter]))),
    ),
    { command: options.command, context: options.context, realIO, sourceEnv },
  );
  const exit = await Effect.runPromiseExit(
    options.tracer === undefined
      ? diagnosedProgram.pipe(Effect.provideService(References.TracerEnabled, false))
      : diagnosedProgram.pipe(
          Effect.provideService(Tracer.Tracer, options.tracer),
          Effect.provideService(References.TracerEnabled, true),
        ),
  );
  if (run.pipe.broken()) return;
  const redactor = await Effect.runPromise(redaction.forProfile("secrets", { sourceEnv }));
  if (Exit.isFailure(exit)) await commitFallback(exit.cause, options, run, redactor);
  // The trace summary follows the document: the root span closes only after the document is written.
  if (capture !== undefined && options.traceDisplay === true && !machineStdout) {
    await Effect.runPromise(
      writeDiagnosticLine(redactor.redactString(formatCommandTrace(capture.snapshot()))).pipe(
        Effect.provide(rendererLayer),
      ),
    );
  }
};
