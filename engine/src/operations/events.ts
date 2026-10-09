import { DateTime, Effect, Option } from "effect";

import { LandofileEventStepFailedError, ToolingCompileError } from "@lando/sdk/errors";
import { MessageInfoEvent, MessageWarnEvent, PostInitEvent, PreInitEvent } from "@lando/sdk/events";
import type { ExpressionContext } from "@lando/sdk/expressions";
import type { AppLifecycleEventName, AppPlan, EventStep, LandofileEventName } from "@lando/sdk/schema";
import { LANDO_HOST_EVENT_ENV, ServiceName } from "@lando/sdk/schema";
import { EventService, type LandoEvent, RuntimeProviderRegistry, ShellRunner } from "@lando/sdk/services";

import { RedactionService, collectSecretEnvValues } from "@lando/redaction/service";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import {
  type CompiledEventStep,
  compiledEventsForPlan,
  effectiveEventsForPlan,
} from "../planner/effective-events.ts";
import { effectiveToolingForPlan } from "../planner/effective-tooling.ts";
import { collectAppPlanRedactionTokens } from "../services/app-plan-redaction.ts";
import { EventCommandExecutor } from "../services/event-command-executor.ts";
import { type EventRuntimeError, isEventRuntimeError } from "../tooling/event-errors.ts";
import { EventStepCompileError, compileEventStepProgram } from "../tooling/step-compiler.ts";
import type { ToolingCommandStepLeaf } from "../tooling/step-program.ts";
import { runToolingStepProgram } from "../tooling/step-runner.ts";
import { runCanonicalCommand, withinEventInvocation } from "./event-invocation.ts";
import { eventStepFile, eventStepLabel } from "./event-step-identity.ts";
import { makeEventStepRunners } from "./event-step-runtime.ts";

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
  source?: "host" | "project",
  sourceIndex = 0,
): EventRuntimeError => {
  if (isEventRuntimeError(error)) {
    return error;
  }
  const identity =
    error instanceof EventStepCompileError
      ? { index: error.authoredIndex, kind: error.kind }
      : { index: sourceIndex, kind: authoredStepKind(step) };
  const failure = error instanceof EventStepCompileError ? error.cause : error;
  const label = eventStepLabel(event, source, identity.index);
  return new LandofileEventStepFailedError({
    message: `Event ${label} failed.`,
    event,
    index: identity.index,
    kind: identity.kind,
    exitCode: 1,
    outputTail: redactor.redactString(failure instanceof Error ? failure.message : String(failure)),
    remediation: `Fix ${label}, then rerun the lifecycle command.`,
  });
};

const publishInfo = Effect.fnUntraced(function* (body: string) {
  const events = yield* Effect.serviceOption(EventService);
  if (Option.isNone(events)) return;
  yield* events.value
    .publish(MessageInfoEvent.make({ body, timestamp: DateTime.nowUnsafe() }))
    .pipe(Effect.ignore);
});

const hostStepService = (step: EventStep, primary: string | undefined): string | undefined => {
  if (typeof step === "string") return primary;
  if ("command" in step && step.command !== undefined) return undefined;
  if ("service" in step && step.service !== undefined) return step.service;
  return primary;
};

const STOPPED_CONTAINER_STATUSES = new Set(["exited", "stopped", "created", "dead", "paused"]);

const isStoppedStatus = (status: string | undefined): boolean =>
  status !== undefined && STOPPED_CONTAINER_STATUSES.has(status.toLowerCase());

const inspectHostContainer = Effect.fnUntraced(function* (plan: AppPlan, service: string) {
  const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
  if (Option.isNone(registry)) return undefined;
  const provider = yield* registry.value.select(plan);
  return yield* provider.inspect({ app: plan.id, service: ServiceName.make(service), plan }).pipe(
    Effect.map((info) => info.status ?? info.state),
    Effect.catch((error) =>
      typeof error === "object" && error !== null && "_tag" in error && error._tag === "ServiceNotFoundError"
        ? Effect.succeed("missing" as const)
        : Effect.fail(error),
    ),
  );
});

const resolveCompiledSteps = Effect.fnUntraced(function* (plan: AppPlan, event: LandofileEventName) {
  const compiled = [...(compiledEventsForPlan(plan)?.[event] ?? [])];
  const fallback = effectiveEventsForPlan(plan)?.[event] ?? [];
  if (compiled.length === 0 && fallback.length > 0) {
    return fallback.map(
      (step, sourceIndex): CompiledEventStep => ({
        step,
        source: "project",
        sourceIndex,
        status: "active",
      }),
    );
  }
  const primary = Object.entries(plan.services).find(([, service]) => service.primary === true)?.[0];
  const resolved: CompiledEventStep[] = [];
  for (const entry of compiled) {
    if (entry.status !== "active" || entry.source !== "host") {
      resolved.push(entry);
      continue;
    }
    const service = hostStepService(entry.step, primary);
    if (service === undefined || service === ":host") {
      resolved.push(entry);
      continue;
    }
    const status = yield* inspectHostContainer(plan, service).pipe(
      Effect.mapError((error) =>
        eventError(error, event, entry.step, { redactString: (value) => value }, entry.source, entry.sourceIndex),
      ),
    );
    if (status === "missing" || isStoppedStatus(status)) {
      const reason =
        status === "missing" ? `service ${service} is not running` : `service ${service} is ${status}`;
      resolved.push({ ...entry, status: "skipped", skipReason: reason });
      continue;
    }
    resolved.push(entry);
  }
  return resolved;
});

export const runAppEvent = Effect.fn("AppOperation.runEvent")(function* (
  plan: AppPlan,
  event: LandofileEventName,
  payload?: ExpressionContext["event"],
): Effect.fn.Return<void, EventRuntimeError> {
  const compiled = yield* resolveCompiledSteps(plan, event);
  const skippedByHostGuard = compiled.some(
    (entry) => entry.source === "host" && entry.skipReason === `${LANDO_HOST_EVENT_ENV}=1`,
  );
  if (skippedByHostGuard) {
    yield* publishInfo(`Skipping hostEvents because ${LANDO_HOST_EVENT_ENV}=1.`);
  } else {
    for (const entry of compiled) {
      if (entry.status !== "skipped" || entry.source !== "host") continue;
      yield* publishInfo(
        `Skipped ${eventStepLabel(event, "host", entry.sourceIndex)}: ${entry.skipReason ?? "skipped"}.`,
      );
    }
  }
  const runnable = compiled.filter((entry) => entry.status === "active");
  const first = runnable[0];
  if (first === undefined) return;
  return yield* withinEventInvocation(
    { app: plan.id, event, file: eventStepFile(first.source, plan.metadata.source) },
    Effect.gen(function* () {
      const eventsOption = yield* Effect.serviceOption(EventService);
      const redactionOption = yield* Effect.serviceOption(RedactionService);
      const privateFileAccess = yield* Effect.serviceOption(PrivateFileAccessService);
      const shellRunner = yield* Effect.serviceOption(ShellRunner);
      if (Option.isNone(eventsOption) || Option.isNone(redactionOption) || Option.isNone(privateFileAccess)) {
        return yield* Effect.fail(
          new LandofileEventStepFailedError({
            message: `Event ${eventStepLabel(event, first.source, first.sourceIndex)} requires the app event runtime.`,
            event,
            index: first.sourceIndex,
            kind: authoredStepKind(first.step),
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
          ...runnable.flatMap((entry) => redactionValuesForStep(entry.step, tooling)),
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
      const program = yield* compileEventStepProgram(
        runnable.map((entry) => entry.step),
        validateCommand,
        runnable.map((entry) => ({ authoredIndex: entry.sourceIndex, source: entry.source })),
      ).pipe(Effect.mapError((error) => eventError(error, event, first.step, redactor, first.source)));
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
      ).pipe(Effect.mapError((error) => eventError(error, event, first.step, redactor, first.source)));
    }),
  );
});

export const runPostAppEvent = Effect.fn("AppOperation.runPostEvent")(function* (
  plan: AppPlan,
  event: AppLifecycleEventName,
  payload?: ExpressionContext["event"],
) {
  return yield* runAppEvent(plan, event, payload).pipe(
    Effect.catch((error) =>
      EventService.pipe(
        Effect.flatMap((events) =>
          events.publish(
            MessageWarnEvent.make({
              body: [error.message, error.remediation].join(" "),
              timestamp: DateTime.nowUnsafe(),
            }),
          ),
        ),
      ),
    ),
  );
});

export const publishAndRunAppEvent = Effect.fnUntraced(function* (
  plan: AppPlan,
  name: LandofileEventName,
  event: LandoEvent & ExpressionContext["event"],
) {
  const events = yield* EventService;
  yield* events.publish(event);
  yield* runAppEvent(plan, name, event);
});

export const publishAndRunPostAppEvent = Effect.fnUntraced(function* (
  plan: AppPlan,
  name: AppLifecycleEventName,
  event: LandoEvent & ExpressionContext["event"],
) {
  const events = yield* EventService;
  yield* events.publish(event);
  yield* runPostAppEvent(plan, name, event);
});

export const runAppInitEvents = Effect.fn("AppOperation.initEvents")(function* (plan: AppPlan) {
  const app = { kind: "user" as const, id: plan.id, root: plan.root };
  const pre = PreInitEvent.make({ app, timestamp: DateTime.nowUnsafe() });
  yield* publishAndRunAppEvent(plan, "pre-init", pre);
  const post = PostInitEvent.make({ app, timestamp: DateTime.nowUnsafe() });
  yield* publishAndRunAppEvent(plan, "post-init", post);
});
