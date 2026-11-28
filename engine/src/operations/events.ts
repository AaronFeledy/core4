import {
  RedactionService,
  collectSecretStructuralValues,
  createStandaloneRedactor,
} from "@lando/redaction/service";
import { mapFailures } from "@lando/sdk/command-result";
import { LandofileEventStepFailedError, ToolingCompileError } from "@lando/sdk/errors";
import { MessageInfoEvent, MessageWarnEvent, PostInitEvent, PreInitEvent } from "@lando/sdk/events";
import type { ExpressionContext } from "@lando/sdk/expressions";
import type {
  AppPlan,
  EventStep,
  EventStepPlan,
  LandofileEventName,
  LandofileEventsOutcome,
} from "@lando/sdk/schema";
import { LANDO_HOST_EVENT_ENV, ServiceName, isDownRunStatus } from "@lando/sdk/schema";
// allow: SIZE_OK - the lifecycle bracket owns admission, execution, and failure compensation as one scoped coordinator.
import {
  EnvironmentValueResolver,
  EventService,
  type LandoEvent,
  ProcessRunner,
  RuntimeProviderRegistry,
  ShellRunner,
} from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Option } from "effect";
import { mapFailureErrors } from "../lifecycle/failure-compensation.ts";
import { invocationAuthorityForPlan, sitesUnder } from "../planner/invocation-authority.ts";
import { EventCommandExecutor } from "../services/event-command-executor.ts";
import { registerPlanRedaction } from "../services/plan-redaction.ts";
import { type EventRuntimeError, isEventRuntimeError } from "../tooling/event-errors.ts";
import { EventStepCompileError, compileEventStepProgram } from "../tooling/step-compiler.ts";
import type { ToolingCommandStepLeaf } from "../tooling/step-program.ts";
import { runToolingStepProgram } from "../tooling/step-runner.ts";
import { EventInvocationSignal, runCanonicalCommand, withinEventInvocation } from "./event-invocation.ts";
import { eventStepFailure } from "./event-step-failure.ts";
import { eventStepFile, eventStepLabel } from "./event-step-identity.ts";
import { type EventRedactionSources, makeEventStepRunners } from "./event-step-runtime.ts";
import { resolveInvocationServiceUrls } from "./invocation-service-urls.ts";

interface EventRedactor {
  readonly redactString: (value: string) => string;
}

const authoredStepKind = (step: EventStep): "cmd" | "task" | "command" => {
  if (typeof step === "string") return "cmd";
  if ("task" in step && step.task !== undefined) return "task";
  if ("command" in step && step.command !== undefined) return "command";
  return "cmd";
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
  const stepSource = error instanceof EventStepCompileError ? error.source : source;
  // Failures that reach this point happened outside a step's process: compiling the program or
  // evaluating a predicate or selector. None of them has an exit code.
  return eventStepFailure(
    { event, label: eventStepLabel(event, stepSource, identity.index), source: stepSource, ...identity },
    failure,
    redactor,
  );
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

const inspectHostContainer = Effect.fnUntraced(function* (plan: AppPlan, service: string) {
  const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
  if (Option.isNone(registry)) return undefined;
  const provider = yield* registry.value.select(plan);
  return yield* provider.inspect({ app: plan.id, service: ServiceName.make(service), plan }).pipe(
    Effect.map((info) => info.status),
    Effect.catch((error) =>
      typeof error === "object" && error !== null && "_tag" in error && error._tag === "ServiceNotFoundError"
        ? Effect.succeed("absent" as const)
        : Effect.fail(error),
    ),
  );
});

const resolveCompiledSteps = Effect.fnUntraced(function* (
  plan: AppPlan,
  event: LandofileEventName,
  context: { readonly redactor: EventRedactor; readonly services?: readonly unknown[] },
) {
  const compiled = plan.events?.[event] ?? [];
  const primary = Object.entries(plan.services).find(([, service]) => service.primary === true)?.[0];
  const resolved: EventStepPlan[] = [];
  for (const entry of compiled) {
    if (entry.status !== "active") {
      resolved.push(entry);
      continue;
    }
    const service = hostStepService(entry.step, primary);
    const scopedGuard =
      context.services !== undefined &&
      authoredStepKind(entry.step) === "cmd" &&
      !context.services.includes(service);
    const inspect = entry.source === "host" || scopedGuard;
    if (service === undefined || service === ":host" || !inspect) {
      resolved.push(entry);
      continue;
    }
    const status = yield* inspectHostContainer(plan, service).pipe(
      mapFailures((error) =>
        eventError(error, event, entry.step, context.redactor, entry.source, entry.sourceIndex),
      ),
    );
    // A down container cannot run a step, so the step is skipped rather than failed.
    if (status !== undefined && isDownRunStatus(status)) {
      if (scopedGuard && entry.source !== "host") {
        yield* publishInfo(
          `Skipped events.${event}[${entry.sourceIndex}]: service ${service} is not running.`,
        );
        continue;
      }
      const reason =
        status === "absent" ? `service ${service} is not running` : `service ${service} is ${status}`;
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
  requestSignal?: AbortSignal,
): Effect.fn.Return<void, EventRuntimeError> {
  const signal = requestSignal ?? (yield* EventInvocationSignal);
  const redactionOption = yield* Effect.serviceOption(RedactionService);
  const planValues = yield* registerPlanRedaction(plan);
  const inspectRedactor = Option.isSome(redactionOption)
    ? yield* redactionOption.value.forProfile("secrets", {
        sourceEnv: process.env,
        redactionTokens: planValues.substring,
        wholeTokenValues: planValues.wholeToken,
      })
    : { redactString: () => "Provider inspection failed." };
  const compiled = yield* resolveCompiledSteps(plan, event, {
    redactor: inspectRedactor,
    ...(Array.isArray(payload?.services) ? { services: payload.services } : {}),
  });
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
      const privateFileAccess = yield* Effect.serviceOption(PrivateFileAccessService);
      const shellRunner = yield* Effect.serviceOption(ShellRunner);
      if (Option.isNone(eventsOption) || Option.isNone(redactionOption) || Option.isNone(privateFileAccess)) {
        return yield* Effect.fail(
          new LandofileEventStepFailedError({
            message: `Event ${eventStepLabel(event, first.source, first.sourceIndex)} requires the app event runtime.`,
            event,
            index: first.sourceIndex,
            kind: authoredStepKind(first.step),
            outputTail: "",
            remediation: "Run the lifecycle command with the app bootstrap layer.",
          }),
        );
      }
      const appPlanRedactionTokens = planValues.substring;
      const publicValues = planValues.publicValues;
      const redactor = yield* redactionOption.value.forProfile("secrets", {
        sourceEnv: process.env,
        redactionTokens: appPlanRedactionTokens,
      });
      const collectRecords = (records: EventRedactionSources["env"]): string[] =>
        (records ?? []).flatMap((record) => {
          if (record === undefined) return [];
          return Object.entries(record).flatMap(([name, value]) =>
            (Array.isArray(value) ? value : [value]).flatMap((occurrence) =>
              typeof occurrence === "string"
                ? collectSecretStructuralValues({ [name]: occurrence }, publicValues)
                : [],
            ),
          );
        });
      const redactorFor = Effect.fnUntraced(function* (sources: EventRedactionSources) {
        const envValues = (sources.env ?? []).flatMap((record) =>
          Object.entries(record ?? {}).flatMap(([name, value]) =>
            (Array.isArray(value) ? value : [value]).flatMap((occurrence) =>
              typeof occurrence === "string" ? [{ [name]: occurrence }] : [],
            ),
          ),
        );
        const values = yield* registerPlanRedaction(plan, envValues);
        const redactionTokens = [
          ...(sources.directTokens ?? []),
          ...values.substring,
          ...collectRecords(sources.input),
        ];
        yield* redactionOption.value.registerValues(redactionTokens);
        const scopeOptions = { sourceEnv: process.env, redactionTokens };
        const redactor = yield* redactionOption.value.forProfile("secrets", scopeOptions);
        const payloadValues = yield* redactionOption.value.payloadValues(scopeOptions);
        return { redactor, redactionTokens, payloadValues };
      });
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
                mapFailures((cause) => {
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
        runnable.map((entry) => ({
          authoredIndex: entry.sourceIndex,
          source: entry.source,
          invocationSites: sitesUnder(invocationAuthorityForPlan(plan)?.sites ?? [], [
            entry.source === "host" ? "hostEvents" : "events",
            event,
            entry.sourceIndex,
          ]),
        })),
      ).pipe(mapFailureErrors((error) => eventError(error, event, first.step, redactor, first.source)));
      const context: ExpressionContext = payload === undefined ? {} : { event: payload };
      const environmentResolver = yield* Effect.serviceOption(EnvironmentValueResolver);
      const processRunner = yield* Effect.serviceOption(ProcessRunner);
      yield* runToolingStepProgram(
        program,
        context,
        makeEventStepRunners({
          plan,
          event,
          ...(signal === undefined ? {} : { signal }),
          events: eventsOption.value,
          privateFileAccess: privateFileAccess.value,
          environmentResolver,
          ...(Option.isSome(processRunner) ? { processRunner: processRunner.value } : {}),
          ...(Option.isSome(shellRunner) ? { hostRunner: shellRunner.value } : {}),
          redactor,
          redactorFor,
          runCanonical: (leaf, redactionTokens) => runCanonicalCommand(plan, leaf, redactionTokens, signal),
        }),
        // Event steps have no defaults expansion, so a site's authored path is its effective path.
        (sites) =>
          resolveInvocationServiceUrls({
            plan,
            tool: event,
            sites,
            effectivePath: (site) => site.source.path,
          }),
      ).pipe(mapFailureErrors((error) => eventError(error, event, first.step, redactor, first.source)));
    }),
  );
});

type FailedPostEvent = Extract<LandofileEventsOutcome, { status: "failed" }>;

export const runPostAppEvent = Effect.fn("AppOperation.runPostEvent")(function* (
  plan: AppPlan,
  event: FailedPostEvent["event"],
  payload?: ExpressionContext["event"],
) {
  return yield* runAppEvent(plan, event, payload).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const events = yield* EventService;
        const service = yield* Effect.serviceOption(RedactionService);
        const tokens = yield* registerPlanRedaction(plan);
        const options = {
          sourceEnv: process.env,
          redactionTokens: tokens.substring,
          wholeTokenValues: tokens.wholeToken,
        };
        const redactor = Option.isSome(service)
          ? yield* service.value.forProfile("secrets", options)
          : createStandaloneRedactor("secrets", options);
        const stepFailure = {
          _tag: error._tag,
          message: redactor.redactString(error.message),
          remediation: redactor.redactString(error.remediation),
        };
        const tail = error instanceof LandofileEventStepFailedError ? error.outputTail.trim() : "";
        yield* events.publish(
          MessageWarnEvent.make({
            body: [stepFailure.message, ...(tail.length > 0 ? [tail] : []), stepFailure.remediation].join(
              " ",
            ),
            timestamp: DateTime.nowUnsafe(),
          }),
        );
        return { status: "failed", event, stepFailure } satisfies FailedPostEvent;
      }),
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
  name: FailedPostEvent["event"],
  event: LandoEvent & ExpressionContext["event"],
) {
  const events = yield* EventService;
  yield* events.publish(event);
  return yield* runPostAppEvent(plan, name, event);
});

export const runAppInitEvents = Effect.fn("AppOperation.initEvents")(function* (plan: AppPlan) {
  const app = { kind: "user" as const, id: plan.id, root: plan.root };
  const pre = PreInitEvent.make({ app, timestamp: DateTime.nowUnsafe() });
  yield* publishAndRunAppEvent(plan, "pre-init", pre);
  const post = PostInitEvent.make({ app, timestamp: DateTime.nowUnsafe() });
  yield* publishAndRunAppEvent(plan, "post-init", post);
});
