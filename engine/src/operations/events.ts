import { DateTime, Effect, FiberRef, Option } from "effect";

import {
  LandofileEventLifecycleReentryError,
  LandofileEventStepFailedError,
  ToolingCompileError,
} from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import type { ExpressionContext } from "@lando/sdk/expressions";
import type { AppLifecycleEventName, AppPlan, EventStep } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

import { RedactionService, collectSecretEnvValues } from "@lando/redaction/service";
import { effectiveEventsForPlan } from "../planner/effective-events.ts";
import { effectiveToolingForPlan } from "../planner/effective-tooling.ts";
import { collectAppPlanRedactionTokens } from "../services/app-plan-redaction.ts";
import { EventCommandExecutor } from "../services/event-command-executor.ts";
import { compileEventStepProgram } from "../tooling/step-compiler.ts";
import type { ResolvedToolingCommandStepLeaf } from "../tooling/step-runner.ts";
import { runToolingStepProgram } from "../tooling/step-runner.ts";
import { makeEventStepRunners } from "./event-step-runtime.ts";

interface ActiveEventFrame {
  readonly event: AppLifecycleEventName;
  readonly command?: string;
}

interface EventRedactor {
  readonly redactString: (value: string) => string;
}

const activeEventFrames = FiberRef.unsafeMake<ReadonlyArray<ActiveEventFrame>>([]);

const authoredStepKind = (step: EventStep): "cmd" | "task" | "command" => {
  if (typeof step === "string") return "cmd";
  if ("task" in step && step.task !== undefined) return "task";
  if ("command" in step && step.command !== undefined) return "command";
  return "cmd";
};

const redactionValuesForStep = (
  step: EventStep,
  tooling: ReturnType<typeof effectiveToolingForPlan>,
): ReadonlyArray<string> => {
  if (typeof step === "string") return [];
  const env =
    "task" in step && step.task !== undefined
      ? tooling?.[step.task]?.env
      : "env" in step
        ? step.env
        : undefined;
  return env === undefined
    ? []
    : collectSecretEnvValues(
        Object.fromEntries(Object.entries(env).map(([name, value]) => [name, String(value)])),
      );
};

const eventError = (
  error: unknown,
  event: AppLifecycleEventName,
  step: EventStep,
  redactor: EventRedactor,
): LandofileEventLifecycleReentryError | LandofileEventStepFailedError | ToolingCompileError => {
  if (
    error instanceof LandofileEventLifecycleReentryError ||
    error instanceof LandofileEventStepFailedError ||
    error instanceof ToolingCompileError
  ) {
    return error;
  }
  return new LandofileEventStepFailedError({
    message: `Event ${event} step 1 failed.`,
    event,
    index: 0,
    kind: authoredStepKind(step),
    exitCode: 1,
    outputTail: redactor.redactString(error instanceof Error ? error.message : String(error)),
    remediation: `Fix ${event} step 1, then rerun the lifecycle command.`,
  });
};

const runCanonicalCommand = (plan: AppPlan, leaf: ResolvedToolingCommandStepLeaf) =>
  Effect.gen(function* () {
    const executor = yield* Effect.serviceOption(EventCommandExecutor);
    if (Option.isNone(executor)) {
      return yield* Effect.fail(
        new ToolingCompileError({
          message: `Canonical command event step ${leaf.command} is unavailable in this runtime.`,
          tool: leaf.command,
          remediation: "Use the app bootstrap layer that provides canonical command invocation.",
        }),
      );
    }
    const active = yield* FiberRef.get(activeEventFrames);
    const invokingFrames = active.map((frame, index) =>
      index === active.length - 1 ? { ...frame, command: leaf.command } : frame,
    );
    const result = yield* executor.value
      .run({
        command: leaf.command,
        flags: leaf.flags,
        args: [...leaf.args, ...leaf.raw],
        cwd: String(plan.root),
        silent: leaf.silent,
      })
      .pipe(Effect.locally(activeEventFrames, invokingFrames));
    return { ...result, tool: leaf.command, service: ":lando" };
  });

export const runAppEvent = (
  plan: AppPlan,
  event: AppLifecycleEventName,
  payload?: ExpressionContext["event"],
): Effect.Effect<
  void,
  LandofileEventLifecycleReentryError | LandofileEventStepFailedError | ToolingCompileError
> => {
  const steps = effectiveEventsForPlan(plan)?.[event] ?? [];
  const first = steps[0];
  if (first === undefined) return Effect.void;
  return Effect.gen(function* () {
    const active = yield* FiberRef.get(activeEventFrames);
    const reentered = active.findLast((frame) => frame.event === event);
    if (reentered !== undefined) {
      const command = reentered.command ?? event;
      return yield* Effect.fail(
        new LandofileEventLifecycleReentryError({
          message: `Command ${command} reentered lifecycle event ${event}.`,
          event,
          command,
          remediation: "Remove the lifecycle command cycle or call a non-lifecycle command from this event.",
        }),
      );
    }
    return yield* Effect.gen(function* () {
      const eventsOption = yield* Effect.serviceOption(EventService);
      const redactionOption = yield* Effect.serviceOption(RedactionService);
      if (Option.isNone(eventsOption) || Option.isNone(redactionOption)) {
        return yield* Effect.fail(
          new LandofileEventStepFailedError({
            message: `Event ${event} requires the app event runtime.`,
            event,
            index: 0,
            kind: authoredStepKind(first),
            exitCode: 1,
            outputTail: "",
            remediation: "Run the lifecycle command with the app bootstrap layer.",
          }),
        );
      }
      const tooling = effectiveToolingForPlan(plan);
      const redactor = yield* redactionOption.value.forProfile("secrets", {
        sourceEnv: process.env,
        redactionTokens: [
          ...collectAppPlanRedactionTokens(plan),
          ...steps.flatMap((step) => redactionValuesForStep(step, tooling)),
        ],
      });
      const program = yield* compileEventStepProgram(steps).pipe(
        Effect.mapError((error) => eventError(error, event, first, redactor)),
      );
      const context: ExpressionContext = payload === undefined ? {} : { event: payload };
      yield* runToolingStepProgram(
        program,
        context,
        makeEventStepRunners({
          plan,
          event,
          events: eventsOption.value,
          redactor,
          runCanonical: (leaf) => runCanonicalCommand(plan, leaf),
        }),
      ).pipe(Effect.mapError((error) => eventError(error, event, first, redactor)));
    }).pipe(Effect.locally(activeEventFrames, [...active, { event }]));
  });
};

export const runPostAppEvent = (plan: AppPlan, event: AppLifecycleEventName) =>
  runAppEvent(plan, event).pipe(
    Effect.catchAll((error) =>
      EventService.pipe(
        Effect.flatMap((events) =>
          events.publish(
            MessageWarnEvent.make({
              body: `${error.message} ${error.remediation}`,
              timestamp: DateTime.unsafeMake(new Date().toISOString()),
            }),
          ),
        ),
      ),
    ),
  );

export const runAppInitEvents = (plan: AppPlan) =>
  Effect.gen(function* () {
    yield* runAppEvent(plan, "pre-init");
    yield* runPostAppEvent(plan, "post-init");
  });
