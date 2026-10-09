import { join } from "node:path";

import { LANDOFILE_NAME } from "@lando/landofile/discovery";
import { requiresProvider } from "@lando/landofile/tooling-normalize";
import { Clock, type Context, Effect, Option } from "effect";

import { LandofileEventStepFailedError, ToolingCompileError, causeMessage } from "@lando/sdk/errors";
import type { ExpressionContext } from "@lando/sdk/expressions";
import { LANDO_HOST_EVENT_ENV } from "@lando/sdk/schema";
import type { AppPlan, LandofileEventName, ToolingTaskShape } from "@lando/sdk/schema";
import {
  type EventService,
  RuntimeProviderRegistry,
  ShellRunner,
  ToolingEngine,
  type ToolingEngineResult,
} from "@lando/sdk/services";
import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { eventStepLabel } from "./event-step-identity.ts";

import { effectiveToolingForPlan } from "../planner/effective-tooling.ts";
import { type EventRuntimeError, isEventRuntimeError } from "../tooling/event-errors.ts";
import type { ToolingStepLeaf } from "../tooling/step-program.ts";
import type {
  ResolvedToolingCmdStepLeaf,
  ResolvedToolingCommandStepLeaf,
  ResolvedToolingStepLeaf,
  ResolvedToolingTaskStepLeaf,
  ToolingStepRunners,
} from "../tooling/step-runner.ts";
import { resolveToolingTaskShape } from "../tooling/step-runner.ts";
import { runBunShellTooling } from "./tooling-bun-script.ts";
import { compileToolingInvocations, executeToolingInvocations } from "./tooling-compile.ts";
import { emitToolingOutputProgress } from "./tooling-progress.ts";

const OUTPUT_TAIL_LENGTH = 4_000;

interface Redactor {
  readonly redactString: (value: string) => string;
}

interface EventRedactionScope {
  readonly redactor: Redactor;
  readonly redactionTokens: ReadonlyArray<string>;
}

interface EventRuntimeOptions {
  readonly plan: AppPlan;
  readonly event: LandofileEventName;
  readonly events: Context.Service.Shape<typeof EventService>;
  readonly privateFileAccess: PrivateFileAccess;
  readonly hostRunner?: Context.Service.Shape<typeof ShellRunner>;
  readonly redactor: Redactor;
  readonly redactorFor: (
    records: ReadonlyArray<Readonly<Record<string, unknown>> | undefined>,
    directTokens?: ReadonlyArray<string>,
  ) => Effect.Effect<EventRedactionScope>;
  readonly runCanonical: (
    leaf: ResolvedToolingCommandStepLeaf,
    redactionTokens: ReadonlyArray<string>,
  ) => Effect.Effect<ToolingEngineResult, unknown>;
}

interface EventLeafResult {
  readonly leaf: ResolvedToolingStepLeaf;
  readonly startedAt: number;
  readonly result: ToolingEngineResult;
  readonly redactor: Redactor;
}

type EventLeafError = EventRuntimeError;

const outputTail = (stdout: string, stderr: string): string =>
  `${stdout}${stdout.length > 0 && stderr.length > 0 ? "\n" : ""}${stderr}`.slice(-OUTPUT_TAIL_LENGTH);

const failureExitCode = (error: unknown): number => {
  if (
    typeof error === "object" &&
    error !== null &&
    "exitCode" in error &&
    typeof error.exitCode === "number"
  ) {
    return error.exitCode;
  }
  return 1;
};

const stepFailure = (
  options: EventRuntimeOptions,
  leaf: ToolingStepLeaf | ResolvedToolingStepLeaf,
  error: unknown,
): LandofileEventStepFailedError => {
  const label = eventStepLabel(options.event, leaf.source, leaf.authoredIndex);
  return new LandofileEventStepFailedError({
    message: `Event ${label} failed.`,
    event: options.event,
    index: leaf.authoredIndex,
    kind: leaf.kind,
    ...(leaf.kind === "cmd" && leaf.service !== undefined ? { service: leaf.service } : {}),
    exitCode: failureExitCode(error),
    outputTail: options.redactor.redactString(causeMessage(error)),
    remediation: `Fix ${label}, then rerun the lifecycle command.`,
  });
};

const nonzeroFailure = (
  options: EventRuntimeOptions,
  leaf: ResolvedToolingStepLeaf,
  result: ToolingEngineResult,
): LandofileEventStepFailedError => {
  const label = eventStepLabel(options.event, leaf.source, leaf.authoredIndex);
  return new LandofileEventStepFailedError({
    message: `Event ${label} failed with exit code ${result.exitCode}.`,
    event: options.event,
    index: leaf.authoredIndex,
    kind: leaf.kind,
    ...(String(result.service) === "" ? {} : { service: String(result.service) }),
    exitCode: result.exitCode,
    outputTail: outputTail(
      options.redactor.redactString(result.stdout),
      options.redactor.redactString(result.stderr),
    ),
    remediation: `Fix ${label}, then rerun the lifecycle command.`,
  });
};

const withHostEventEnv = <A, E, R>(
  source: "host" | "project" | undefined,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  if (source !== "host") return work;
  const previous = process.env[LANDO_HOST_EVENT_ENV];
  process.env[LANDO_HOST_EVENT_ENV] = "1";
  return work.pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (previous === undefined) delete process.env[LANDO_HOST_EVENT_ENV];
        else process.env[LANDO_HOST_EVENT_ENV] = previous;
      }),
    ),
  );
};

const toolingRuntime = Effect.fnUntraced(function* (tool: string) {
  const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
  if (Option.isNone(registry)) {
    return yield* Effect.fail(
      new ToolingCompileError({
        message: "Runtime provider registry is unavailable for event execution.",
        tool,
      }),
    );
  }
  const engine = yield* Effect.serviceOption(ToolingEngine);
  if (Option.isNone(engine)) {
    return yield* Effect.fail(
      new ToolingCompileError({ message: "Tooling engine is unavailable for event execution.", tool }),
    );
  }
  return { registry: registry.value, engine: engine.value };
});

const runInvocation = Effect.fnUntraced(function* (
  options: EventRuntimeOptions,
  tool: string,
  task: ToolingTaskShape,
  invocationOptions: {
    readonly user?: string;
    readonly redactionTokens?: ReadonlyArray<string>;
  } = {},
) {
  const runtime = yield* toolingRuntime(tool);
  const compiled = yield* compileToolingInvocations({
    name: tool,
    lookupKey: tool,
    task,
    source: { path: join(String(options.plan.root), LANDOFILE_NAME), task: tool },
    ...(invocationOptions.user === undefined ? {} : { user: invocationOptions.user }),
  });
  if (
    options.hostRunner === undefined &&
    compiled.invocations.some((invocation) => invocation.service === ":host")
  ) {
    return yield* Effect.fail(
      new ToolingCompileError({
        message: "ShellRunner is unavailable for host event execution.",
        tool,
      }),
    );
  }
  // An event step is an inline invocation of an already-running lifecycle, so it executes
  // the compiled steps directly and never re-fires the task's own pre/post brackets.
  const execution = executeToolingInvocations({
    plan: options.plan,
    tool,
    invocations: compiled.invocations,
    requiresProvider: requiresProvider(compiled.normalized),
    ...(invocationOptions.redactionTokens === undefined
      ? {}
      : { redactionTokens: invocationOptions.redactionTokens }),
  }).pipe(
    Effect.provideService(ToolingEngine, runtime.engine),
    Effect.provideService(RuntimeProviderRegistry, runtime.registry),
  );
  return yield* options.hostRunner === undefined
    ? execution
    : execution.pipe(Effect.provideService(ShellRunner, options.hostRunner));
});

const runCmd = Effect.fnUntraced(function* (options: EventRuntimeOptions, leaf: ResolvedToolingCmdStepLeaf) {
  const startedAt = yield* Clock.currentTimeMillis;
  const { redactor, redactionTokens } = yield* options.redactorFor([leaf.env]);
  const task: ToolingTaskShape = {
    cmd: leaf.command,
    ...(leaf.service === undefined ? {} : { service: leaf.service }),
    ...(leaf.env === undefined ? {} : { env: leaf.env }),
    ...(leaf.dir === undefined ? {} : { dir: leaf.dir }),
  };
  const result = yield* withHostEventEnv(
    leaf.source,
    runInvocation(options, `${options.event}`, task, {
      ...(leaf.user === undefined ? {} : { user: leaf.user }),
      redactionTokens,
    }).pipe(Effect.mapError((error) => stepFailure({ ...options, redactor }, leaf, error))),
  );
  return { leaf, result, startedAt, redactor };
});

const runTask = Effect.fnUntraced(function* (
  options: EventRuntimeOptions,
  leaf: ResolvedToolingTaskStepLeaf,
  context: ExpressionContext,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const task = effectiveToolingForPlan(options.plan)?.[leaf.task];
  const variableRedaction = yield* options.redactorFor([leaf.vars]);
  if (task === undefined) {
    const script = yield* runBunShellTooling(
      { name: leaf.task, cwd: String(options.plan.root), renderProgress: false },
      String(options.plan.root),
    ).pipe(Effect.provideService(PrivateFileAccessService, options.privateFileAccess));
    if (script !== undefined) {
      return { leaf, result: script, startedAt, redactor: variableRedaction.redactor };
    }
    return yield* Effect.fail(
      stepFailure(
        { ...options, redactor: variableRedaction.redactor },
        leaf,
        new ToolingCompileError({
          message: `Unknown event tooling task ${leaf.task}.`,
          tool: leaf.task,
          remediation: "Define the named tooling task or update the event to reference an existing task.",
        }),
      ),
    );
  }
  const resolved = yield* resolveToolingTaskShape(task, context).pipe(
    Effect.mapError((error) =>
      stepFailure({ ...options, redactor: variableRedaction.redactor }, leaf, error),
    ),
  );
  const { redactor, redactionTokens } = yield* options.redactorFor([resolved.env, leaf.vars]);
  const result = yield* runInvocation(options, leaf.task, resolved, { redactionTokens }).pipe(
    Effect.mapError((error) => stepFailure({ ...options, redactor }, leaf, error)),
  );
  return { leaf, result, startedAt, redactor };
});

const publish = Effect.fnUntraced(function* (options: EventRuntimeOptions, execution: EventLeafResult) {
  return yield* emitToolingOutputProgress({
    events: options.events,
    tool: `${options.event}:${execution.leaf.authoredIndex + 1}`,
    service: String(execution.result.service),
    stdout: execution.redactor.redactString(execution.result.stdout),
    stderr: execution.redactor.redactString(execution.result.stderr),
    exitCode: execution.result.exitCode,
    durationMs: (yield* Clock.currentTimeMillis) - execution.startedAt,
  });
});

const finish = (options: EventRuntimeOptions, execution: EventLeafResult) => {
  if (execution.result.exitCode === 0) return Effect.succeed(execution);
  const failure = Effect.fail(
    nonzeroFailure({ ...options, redactor: execution.redactor }, execution.leaf, execution.result),
  );
  return execution.leaf.silent ? failure : publish(options, execution).pipe(Effect.andThen(failure));
};

export const makeEventStepRunners = (
  options: EventRuntimeOptions,
): ToolingStepRunners<EventLeafError, EventLeafResult> => {
  const checked = (
    leaf: ResolvedToolingStepLeaf,
    effect: Effect.Effect<EventLeafResult, unknown>,
  ): Effect.Effect<EventLeafResult, EventLeafError> =>
    effect.pipe(
      Effect.catch((error) =>
        isEventRuntimeError(error) ? Effect.fail(error) : Effect.fail(stepFailure(options, leaf, error)),
      ),
      Effect.flatMap((execution) => finish(options, execution)),
    );
  return {
    runCmd: (leaf) => checked(leaf, runCmd(options, leaf)),
    runTask: (leaf, context) => checked(leaf, runTask(options, leaf, context)),
    runCommand: (leaf) =>
      checked(
        leaf,
        withHostEventEnv(
          leaf.source,
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((startedAt) => {
              return options.redactorFor([leaf.flags, leaf.args], leaf.raw).pipe(
                Effect.flatMap(({ redactor, redactionTokens }) =>
                  options.runCanonical(leaf, redactionTokens).pipe(
                    Effect.mapError((error) =>
                      isEventRuntimeError(error) ? error : stepFailure({ ...options, redactor }, leaf, error),
                    ),
                    Effect.map((result) => ({ leaf, result, startedAt, redactor })),
                  ),
                ),
              );
            }),
          ),
        ),
      ),
    present: (execution) => publish(options, execution.result),
    mapLeafError: (leaf, error) => (isEventRuntimeError(error) ? error : stepFailure(options, leaf, error)),
  };
};
