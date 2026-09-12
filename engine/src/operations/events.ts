import { DateTime, Effect, Option } from "effect";

import { LandofileEventStepFailedError, ToolingCompileError } from "@lando/sdk/errors";
import { PostInitEvent, PreInitEvent } from "@lando/sdk/events";
import type { ExpressionContext } from "@lando/sdk/expressions";
import type { AppPlan, EventStep, LandofileEventName } from "@lando/sdk/schema";
import { EventService, ShellRunner } from "@lando/sdk/services";

import { RedactionService, collectSecretEnvValues } from "@lando/redaction/service";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { effectiveEventsForPlan } from "../planner/effective-events.ts";
import { effectiveToolingForPlan } from "../planner/effective-tooling.ts";
import { collectAppPlanRedactionTokens } from "../services/app-plan-redaction.ts";
import { EventCommandExecutor } from "../services/event-command-executor.ts";
import { type EventRuntimeError, isEventRuntimeError } from "../tooling/event-errors.ts";
import { EventStepCompileError, compileEventStepProgram } from "../tooling/step-compiler.ts";
import type { ToolingCommandStepLeaf } from "../tooling/step-program.ts";
import { runToolingStepProgram } from "../tooling/step-runner.ts";
import { runCanonicalCommand, withinEventInvocation } from "./event-invocation.ts";
import { makeEventStepRunners } from "./event-step-runtime.ts";
export { MAX_EVENT_INVOCATION_DEPTH } from "./event-invocation.ts";

interface EventRedactor {
  readonly redactString: (value: string) => string;
}

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
  event: LandofileEventName,
  step: EventStep,
  redactor: EventRedactor,
): EventRuntimeError => {
  if (isEventRuntimeError(error)) {
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

export const runAppEvent = (
  plan: AppPlan,
  event: LandofileEventName,
  payload?: ExpressionContext["event"],
): Effect.Effect<void, EventRuntimeError> => {
  const steps = effectiveEventsForPlan(plan)?.[event] ?? [];
  const first = steps[0];
  if (first === undefined) return Effect.void;
  return withinEventInvocation(
    { app: plan.id, event, file: plan.metadata.source },
    Effect.gen(function* () {
      const eventsOption = yield* Effect.serviceOption(EventService);
      const redactionOption = yield* Effect.serviceOption(RedactionService);
      const privateFileAccess = yield* Effect.serviceOption(PrivateFileAccessService);
      const shellRunner = yield* Effect.serviceOption(ShellRunner);
      if (Option.isNone(eventsOption) || Option.isNone(redactionOption) || Option.isNone(privateFileAccess)) {
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
          privateFileAccess: privateFileAccess.value,
          ...(Option.isSome(shellRunner) ? { hostRunner: shellRunner.value } : {}),
          redactor,
          redactorFor,
          runCanonical: (leaf, redactionTokens) => runCanonicalCommand(plan, leaf, redactionTokens),
        }),
      ).pipe(Effect.mapError((error) => eventError(error, event, first, redactor)));
    }),
  );
};

export const runAppInitEvents = (plan: AppPlan) =>
  Effect.gen(function* () {
    const events = yield* EventService;
    const app = { kind: "user" as const, id: plan.id, root: plan.root };
    const pre = PreInitEvent.make({ app, timestamp: DateTime.unsafeMake(new Date().toISOString()) });
    yield* events.publish(pre);
    yield* runAppEvent(plan, "pre-init", pre);
    const post = PostInitEvent.make({ app, timestamp: DateTime.unsafeMake(new Date().toISOString()) });
    yield* events.publish(post);
    yield* runAppEvent(plan, "post-init", post);
  });
