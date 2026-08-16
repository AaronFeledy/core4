import { DateTime, Effect, FiberRef, Option } from "effect";

import {
  LandofileEventLifecycleReentryError,
  LandofileEventStepFailedError,
  ToolingCompileError,
} from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import type { AppLifecycleEventName, AppPlan, EventStep, ToolingTaskShape } from "@lando/sdk/schema";
import { EventService, RuntimeProviderRegistry, ToolingEngine } from "@lando/sdk/services";

import { RedactionService, collectSecretEnvValues } from "@lando/redaction/service";
import { effectiveEventsForPlan } from "../planner/effective-events.ts";
import { effectiveToolingForPlan } from "../planner/effective-tooling.ts";
import { collectAppPlanRedactionTokens } from "../services/app-plan-redaction.ts";
import { EventCommandExecutor } from "../services/event-command-executor.ts";
import { runBunShellTooling } from "./tooling-bun-script.ts";
import { emitToolingOutputProgress } from "./tooling-progress.ts";
import { buildToolingInvocation } from "./tooling.ts";

export {
  attachEffectiveEvents,
  compileEffectiveEvents,
  effectiveEventsForPlan,
} from "../planner/effective-events.ts";

const activeEventCommands = FiberRef.unsafeMake<ReadonlyArray<string>>([]);
const OUTPUT_TAIL_LENGTH = 4_000;

const stepKind = (step: EventStep): "cmd" | "task" | "command" => {
  if (typeof step === "string" || step.cmd !== undefined) return "cmd";
  if (step.task !== undefined) return "task";
  return "command";
};

const eventToolingTask = (step: EventStep): ToolingTaskShape | undefined => {
  if (typeof step === "string") return { cmd: step };
  if (step.cmd !== undefined) {
    return {
      cmd: step.cmd,
      ...(step.service === undefined ? {} : { service: step.service }),
      ...(step.env === undefined ? {} : { env: step.env }),
    };
  }
  return undefined;
};

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

const executeEventStep = (plan: AppPlan, event: AppLifecycleEventName, step: EventStep) =>
  Effect.gen(function* () {
    if (typeof step !== "string" && step.command !== undefined) {
      const active = yield* FiberRef.get(activeEventCommands);
      if (active.includes(event)) {
        return yield* Effect.fail(
          new LandofileEventLifecycleReentryError({
            message: `Command ${step.command} reentered lifecycle event ${event}.`,
            event,
            command: step.command,
            remediation:
              "Remove the lifecycle command cycle or call a non-lifecycle command from this event.",
          }),
        );
      }
      const executor = yield* Effect.serviceOption(EventCommandExecutor);
      if (Option.isNone(executor)) {
        return yield* Effect.fail(
          new ToolingCompileError({
            message: `Canonical command event step ${step.command} is unavailable in this runtime.`,
            tool: step.command,
            remediation: "Use the app bootstrap layer that provides canonical command invocation.",
          }),
        );
      }
      const result = yield* executor.value
        .run({ step, cwd: String(plan.root) })
        .pipe(Effect.locally(activeEventCommands, [...active, event]));
      return { ...result, service: ":lando" };
    }

    if (typeof step !== "string" && step.task !== undefined) {
      const task = effectiveToolingForPlan(plan)?.[step.task];
      if (task === undefined) {
        const script = yield* runBunShellTooling(
          { name: step.task, cwd: String(plan.root), renderProgress: false },
          String(plan.root),
        );
        if (script !== undefined) return script;
        return yield* Effect.fail({ exitCode: 1, message: `Unknown event tooling task ${step.task}.` });
      }
      const registryOption = yield* Effect.serviceOption(RuntimeProviderRegistry);
      if (Option.isNone(registryOption)) {
        return yield* Effect.fail(
          new ToolingCompileError({
            message: "Runtime provider registry is unavailable for event execution.",
            tool: step.task,
          }),
        );
      }
      const engineOption = yield* Effect.serviceOption(ToolingEngine);
      if (Option.isNone(engineOption)) {
        return yield* Effect.fail(
          new ToolingCompileError({
            message: "Tooling engine is unavailable for event execution.",
            tool: step.task,
          }),
        );
      }
      const provider = yield* registryOption.value.select(plan);
      const result = yield* engineOption.value.run(buildToolingInvocation(step.task, task), plan, provider);
      return { ...result, service: String(result.service) };
    }

    const task = eventToolingTask(step);
    if (task === undefined) return yield* Effect.fail({ exitCode: 1, message: "Invalid event step." });
    const registryOption = yield* Effect.serviceOption(RuntimeProviderRegistry);
    if (Option.isNone(registryOption)) {
      return yield* Effect.fail(
        new ToolingCompileError({
          message: "Runtime provider registry is unavailable for event execution.",
          tool: event,
        }),
      );
    }
    const engineOption = yield* Effect.serviceOption(ToolingEngine);
    if (Option.isNone(engineOption)) {
      return yield* Effect.fail(
        new ToolingCompileError({
          message: "Tooling engine is unavailable for event execution.",
          tool: event,
        }),
      );
    }
    const provider = yield* registryOption.value.select(plan);
    const result = yield* engineOption.value.run(
      buildToolingInvocation(`${event}`, task, {
        ...(typeof step !== "string" && step.user !== undefined ? { user: step.user } : {}),
      }),
      plan,
      provider,
    );
    return { ...result, service: String(result.service) };
  });

export const runAppEvent = (
  plan: AppPlan,
  event: AppLifecycleEventName,
): Effect.Effect<void, LandofileEventStepFailedError | LandofileEventLifecycleReentryError> => {
  const steps = effectiveEventsForPlan(plan)?.[event] ?? [];
  if (steps.length === 0) return Effect.void;
  return Effect.gen(function* () {
    const eventsOption = yield* Effect.serviceOption(EventService);
    const redactionOption = yield* Effect.serviceOption(RedactionService);
    if (Option.isNone(eventsOption) || Option.isNone(redactionOption)) {
      const step = steps[0];
      if (step === undefined) return;
      return yield* Effect.fail(
        new LandofileEventStepFailedError({
          message: `Event ${event} requires the app event runtime.`,
          event,
          index: 0,
          kind: stepKind(step),
          exitCode: 1,
          outputTail: "",
          remediation: "Run the lifecycle command with the app bootstrap layer.",
        }),
      );
    }
    const events = eventsOption.value;
    const redaction = redactionOption.value;
    const redactor = yield* redaction.forProfile("secrets", {
      sourceEnv: process.env,
      redactionTokens: [
        ...collectAppPlanRedactionTokens(plan),
        ...steps.flatMap((step) =>
          typeof step !== "string" && step.cmd !== undefined && step.env !== undefined
            ? collectSecretEnvValues(
                Object.fromEntries(Object.entries(step.env).map(([name, value]) => [name, String(value)])),
              )
            : [],
        ),
      ],
    });
    for (const [index, step] of steps.entries()) {
      const startedAt = Date.now();
      const outcome = yield* Effect.either(executeEventStep(plan, event, step));
      if (outcome._tag === "Left") {
        if (outcome.left instanceof LandofileEventLifecycleReentryError)
          return yield* Effect.fail(outcome.left);
        const failed = new LandofileEventStepFailedError({
          message: `Event ${event} step ${index + 1} failed.`,
          event,
          index,
          kind: stepKind(step),
          ...(typeof step !== "string" && step.cmd !== undefined && step.service !== undefined
            ? { service: step.service }
            : {}),
          exitCode: failureExitCode(outcome.left),
          outputTail: redactor.redactString(
            outcome.left instanceof Error ? outcome.left.message : String(outcome.left),
          ),
          remediation: `Fix ${event} step ${index + 1}, then rerun the lifecycle command.`,
        });
        return yield* Effect.fail(failed);
      }
      const result = outcome.right;
      yield* emitToolingOutputProgress({
        events,
        tool: `${event}:${index + 1}`,
        service: result.service,
        stdout: redactor.redactString(result.stdout),
        stderr: redactor.redactString(result.stderr),
        exitCode: result.exitCode,
        durationMs: Date.now() - startedAt,
      });
      if (result.exitCode !== 0) {
        return yield* Effect.fail(
          new LandofileEventStepFailedError({
            message: `Event ${event} step ${index + 1} failed with exit code ${result.exitCode}.`,
            event,
            index,
            kind: stepKind(step),
            ...(result.service === "" ? {} : { service: result.service }),
            exitCode: result.exitCode,
            outputTail: redactor.redactString(outputTail(result.stdout, result.stderr)),
            remediation: `Fix ${event} step ${index + 1}, then rerun the lifecycle command.`,
          }),
        );
      }
    }
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
