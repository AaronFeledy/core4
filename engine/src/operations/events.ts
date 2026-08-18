import { DateTime, Effect, FiberRef, Option } from "effect";

import {
  LandofileEventLifecycleReentryError,
  LandofileEventStepFailedError,
  ToolingCompileError,
} from "@lando/sdk/errors";
import { MessageWarnEvent, PostInitEvent, PreInitEvent } from "@lando/sdk/events";
import type { ExpressionContext } from "@lando/sdk/expressions";
import type { AppLifecycleEventName, AppPlan, EventStep } from "@lando/sdk/schema";
import { EventService, ShellRunner } from "@lando/sdk/services";

import { RedactionService, collectSecretEnvValues } from "@lando/redaction/service";
import { effectiveEventsForPlan } from "../planner/effective-events.ts";
import { effectiveToolingForPlan } from "../planner/effective-tooling.ts";
import { collectAppPlanRedactionTokens } from "../services/app-plan-redaction.ts";
import { EventCommandExecutor } from "../services/event-command-executor.ts";
import { EventStepCompileError, compileEventStepProgram } from "../tooling/step-compiler.ts";
import type { ToolingCommandStepLeaf } from "../tooling/step-program.ts";
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
): LandofileEventLifecycleReentryError | LandofileEventStepFailedError => {
  if (
    error instanceof LandofileEventLifecycleReentryError ||
    error instanceof LandofileEventStepFailedError
  ) {
    return error;
  }
  const identity =
    error instanceof EventStepCompileError
      ? { index: error.authoredIndex, kind: error.kind }
      : { index: 0, kind: authoredStepKind(step) };
  const failure = error instanceof EventStepCompileError ? error.cause : error;
  return new LandofileEventStepFailedError({
    message: `Event ${event} step ${identity.index + 1} failed.`,
    event,
    index: identity.index,
    kind: identity.kind,
    exitCode: 1,
    outputTail: redactor.redactString(failure instanceof Error ? failure.message : String(failure)),
    remediation: `Fix ${event} step ${identity.index + 1}, then rerun the lifecycle command.`,
  });
};

const runCanonicalCommand = (
  plan: AppPlan,
  leaf: ResolvedToolingCommandStepLeaf,
  redactionTokens: ReadonlyArray<string>,
) =>
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
        args: leaf.args,
        argv: leaf.raw,
        cwd: String(plan.root),
        silent: leaf.silent,
        plan,
        redactionTokens,
      })
      .pipe(Effect.locally(activeEventFrames, invokingFrames));
    return { ...result, tool: leaf.command, service: ":lando" };
  });

export const runAppEvent = (
  plan: AppPlan,
  event: AppLifecycleEventName,
  payload?: ExpressionContext["event"],
): Effect.Effect<void, LandofileEventLifecycleReentryError | LandofileEventStepFailedError> => {
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
      const shellRunner = yield* Effect.serviceOption(ShellRunner);
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
      const appPlanRedactionTokens = collectAppPlanRedactionTokens(plan);
      const redactor = yield* redactionOption.value.forProfile("secrets", {
        sourceEnv: process.env,
        redactionTokens: [
          ...appPlanRedactionTokens,
          ...steps.flatMap((step) => redactionValuesForStep(step, tooling)),
        ],
      });
      const redactorFor = (
        records: ReadonlyArray<Readonly<Record<string, unknown>> | undefined>,
        directTokens: ReadonlyArray<string> = [],
      ) => {
        const redactionTokens = [
          ...appPlanRedactionTokens,
          ...directTokens,
          ...records.flatMap((record) => {
            if (record === undefined) return [];
            return Object.entries(record).flatMap(([name, value]) =>
              (Array.isArray(value) ? value : [value]).flatMap((occurrence) =>
                collectSecretEnvValues({ [name]: String(occurrence) }),
              ),
            );
          }),
        ];
        return redactionOption.value
          .forProfile("secrets", {
            sourceEnv: process.env,
            redactionTokens,
          })
          .pipe(Effect.map((redactor) => ({ redactor, redactionTokens })));
      };
      const commandExecutor = yield* Effect.serviceOption(EventCommandExecutor);
      const validate = Option.isSome(commandExecutor) ? commandExecutor.value.validate : undefined;
      const validateCommand =
        validate !== undefined
          ? (leaf: ToolingCommandStepLeaf) =>
              validate({
                command: leaf.command,
                flags: leaf.flags,
                args: leaf.args,
                argv: leaf.raw,
                cwd: String(plan.root),
                silent: leaf.silent,
                plan,
              }).pipe(
                Effect.mapError((cause) => {
                  if (cause instanceof ToolingCompileError) return cause;
                  const detail = cause instanceof Error ? cause.message : String(cause);
                  const remediation = (cause as { readonly remediation?: unknown } | null)?.remediation;
                  const suffix =
                    typeof remediation === "string" && remediation.length > 0 ? ` ${remediation}` : "";
                  return new ToolingCompileError({
                    message: `Failed to validate canonical command ${leaf.command}: ${detail}${suffix}`,
                    tool: leaf.command,
                    cause,
                  });
                }),
              )
          : undefined;
      const program = yield* compileEventStepProgram(steps, validateCommand).pipe(
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
          ...(Option.isSome(shellRunner) ? { hostRunner: shellRunner.value } : {}),
          redactor,
          redactorFor,
          runCanonical: (leaf, redactionTokens) => runCanonicalCommand(plan, leaf, redactionTokens),
        }),
      ).pipe(Effect.mapError((error) => eventError(error, event, first, redactor)));
    }).pipe(Effect.locally(activeEventFrames, [...active, { event }]));
  });
};

export const runPostAppEvent = (
  plan: AppPlan,
  event: AppLifecycleEventName,
  payload?: ExpressionContext["event"],
) =>
  runAppEvent(plan, event, payload).pipe(
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
    const events = yield* EventService;
    const app = { kind: "user" as const, id: plan.id, root: plan.root };
    const pre = PreInitEvent.make({ app, timestamp: DateTime.unsafeMake(new Date().toISOString()) });
    yield* events.publish(pre);
    yield* runAppEvent(plan, "pre-init", pre);
    const post = PostInitEvent.make({ app, timestamp: DateTime.unsafeMake(new Date().toISOString()) });
    yield* events.publish(post);
    yield* runPostAppEvent(plan, "post-init", post);
  });
