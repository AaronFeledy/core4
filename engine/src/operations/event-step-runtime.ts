import { type Context, Effect, Option } from "effect";

import {
  LandofileEventLifecycleReentryError,
  LandofileEventStepFailedError,
  ToolingCompileError,
} from "@lando/sdk/errors";
import type { ExpressionContext } from "@lando/sdk/expressions";
import type { AppLifecycleEventName, AppPlan, ToolingTaskShape } from "@lando/sdk/schema";
import {
  type EventService,
  RuntimeProviderRegistry,
  type ShellRunner,
  ToolingEngine,
  type ToolingEngineResult,
} from "@lando/sdk/services";

import { effectiveToolingForPlan } from "../planner/effective-tooling.ts";
import { runHostToolingWith } from "../services/host-tooling-engine.ts";
import { withShellRedactionTokens } from "../services/shell-runner.ts";
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
import { emitToolingOutputProgress } from "./tooling-progress.ts";
import { buildToolingInvocation } from "./tooling.ts";

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
  readonly event: AppLifecycleEventName;
  readonly events: Context.Tag.Service<typeof EventService>;
  readonly hostRunner?: Context.Tag.Service<typeof ShellRunner>;
  readonly redactor: Redactor;
  readonly redactorFor: (
    records: ReadonlyArray<Readonly<Record<string, unknown>> | undefined>,
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

type EventLeafError = LandofileEventLifecycleReentryError | LandofileEventStepFailedError;

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
): LandofileEventStepFailedError =>
  new LandofileEventStepFailedError({
    message: `Event ${options.event} step ${leaf.authoredIndex + 1} failed.`,
    event: options.event,
    index: leaf.authoredIndex,
    kind: leaf.kind,
    ...(leaf.kind === "cmd" && leaf.service !== undefined ? { service: leaf.service } : {}),
    exitCode: failureExitCode(error),
    outputTail: options.redactor.redactString(error instanceof Error ? error.message : String(error)),
    remediation: `Fix ${options.event} step ${leaf.authoredIndex + 1}, then rerun the lifecycle command.`,
  });

const nonzeroFailure = (
  options: EventRuntimeOptions,
  leaf: ResolvedToolingStepLeaf,
  result: ToolingEngineResult,
): LandofileEventStepFailedError =>
  new LandofileEventStepFailedError({
    message: `Event ${options.event} step ${leaf.authoredIndex + 1} failed with exit code ${result.exitCode}.`,
    event: options.event,
    index: leaf.authoredIndex,
    kind: leaf.kind,
    ...(String(result.service) === "" ? {} : { service: String(result.service) }),
    exitCode: result.exitCode,
    outputTail: outputTail(
      options.redactor.redactString(result.stdout),
      options.redactor.redactString(result.stderr),
    ),
    remediation: `Fix ${options.event} step ${leaf.authoredIndex + 1}, then rerun the lifecycle command.`,
  });

const toolingRuntime = (tool: string) =>
  Effect.gen(function* () {
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

const runInvocation = (
  options: EventRuntimeOptions,
  tool: string,
  task: ToolingTaskShape,
  invocationOptions: {
    readonly user?: string;
    readonly redactionTokens?: ReadonlyArray<string>;
  } = {},
) =>
  Effect.gen(function* () {
    const runtime = yield* toolingRuntime(tool);
    const provider = yield* runtime.registry.select(options.plan);
    const invocation = buildToolingInvocation(tool, task, invocationOptions);
    if (invocation.service === ":host") {
      if (options.hostRunner === undefined) {
        return yield* Effect.fail(
          new ToolingCompileError({
            message: "ShellRunner is unavailable for host event execution.",
            tool,
          }),
        );
      }
      return yield* withShellRedactionTokens(
        invocationOptions.redactionTokens ?? [],
        runHostToolingWith(options.hostRunner, invocation, options.plan, provider),
      );
    }
    return yield* runtime.engine.run(invocation, options.plan, provider);
  });

const runCmd = (options: EventRuntimeOptions, leaf: ResolvedToolingCmdStepLeaf) =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const { redactor, redactionTokens } = yield* options.redactorFor([leaf.env]);
    const task: ToolingTaskShape = {
      cmd: leaf.command,
      ...(leaf.service === undefined ? {} : { service: leaf.service }),
      ...(leaf.env === undefined ? {} : { env: leaf.env }),
      ...(leaf.dir === undefined ? {} : { dir: leaf.dir }),
    };
    const result = yield* runInvocation(options, `${options.event}`, task, {
      ...(leaf.user === undefined ? {} : { user: leaf.user }),
      redactionTokens,
    }).pipe(Effect.mapError((error) => stepFailure({ ...options, redactor }, leaf, error)));
    return { leaf, result, startedAt, redactor };
  });

const runTask = (
  options: EventRuntimeOptions,
  leaf: ResolvedToolingTaskStepLeaf,
  context: ExpressionContext,
) =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const task = effectiveToolingForPlan(options.plan)?.[leaf.task];
    const variableRedaction = yield* options.redactorFor([leaf.vars]);
    if (task === undefined) {
      const script = yield* runBunShellTooling(
        { name: leaf.task, cwd: String(options.plan.root), renderProgress: false },
        String(options.plan.root),
      );
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

const publish = (options: EventRuntimeOptions, execution: EventLeafResult) =>
  emitToolingOutputProgress({
    events: options.events,
    tool: `${options.event}:${execution.leaf.authoredIndex + 1}`,
    service: String(execution.result.service),
    stdout: execution.redactor.redactString(execution.result.stdout),
    stderr: execution.redactor.redactString(execution.result.stderr),
    exitCode: execution.result.exitCode,
    durationMs: Date.now() - execution.startedAt,
  });

const finish = (options: EventRuntimeOptions, execution: EventLeafResult) => {
  if (execution.result.exitCode === 0) return Effect.succeed(execution);
  const failure = Effect.fail(
    nonzeroFailure({ ...options, redactor: execution.redactor }, execution.leaf, execution.result),
  );
  return execution.leaf.silent ? failure : publish(options, execution).pipe(Effect.zipRight(failure));
};

export const makeEventStepRunners = (
  options: EventRuntimeOptions,
): ToolingStepRunners<EventLeafError, EventLeafResult> => {
  const checked = (
    leaf: ResolvedToolingStepLeaf,
    effect: Effect.Effect<EventLeafResult, unknown>,
  ): Effect.Effect<EventLeafResult, EventLeafError> =>
    effect.pipe(
      Effect.catchAll((error) =>
        error instanceof LandofileEventLifecycleReentryError || error instanceof LandofileEventStepFailedError
          ? Effect.fail(error)
          : Effect.fail(stepFailure(options, leaf, error)),
      ),
      Effect.flatMap((execution) => finish(options, execution)),
    );
  return {
    runCmd: (leaf) => checked(leaf, runCmd(options, leaf)),
    runTask: (leaf, context) => checked(leaf, runTask(options, leaf, context)),
    runCommand: (leaf) =>
      checked(
        leaf,
        Effect.suspend(() => {
          const startedAt = Date.now();
          return options.redactorFor([leaf.flags]).pipe(
            Effect.flatMap(({ redactor, redactionTokens }) =>
              options.runCanonical(leaf, redactionTokens).pipe(
                Effect.mapError((error) =>
                  error instanceof LandofileEventLifecycleReentryError
                    ? error
                    : stepFailure({ ...options, redactor }, leaf, error),
                ),
                Effect.map((result) => ({ leaf, result, startedAt, redactor })),
              ),
            ),
          );
        }),
      ),
    present: (execution) => publish(options, execution.result),
    mapLeafError: (leaf, error) =>
      error instanceof LandofileEventLifecycleReentryError || error instanceof LandofileEventStepFailedError
        ? error
        : stepFailure(options, leaf, error),
  };
};
