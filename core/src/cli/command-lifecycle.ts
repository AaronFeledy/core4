import { Cause, Clock, Context, DateTime, Effect, Exit, Option, Schema } from "effect";

import { CliCommandErrorEvent, CliCommandInitEvent, CliCommandRunEvent } from "@lando/sdk/events";
import { EventService, type LandoEvent, Logger } from "@lando/sdk/services";

import * as LandoEventService from "@lando/engine/services/event-service";
import { RedactionService } from "@lando/redaction/service";
import { summarizeInvocationArgv, summarizeInvocationRecord } from "./invocation-summary";

export interface CliInvocationSnapshot {
  readonly commandId: string;
  readonly argv: ReadonlyArray<string>;
  readonly args: Readonly<Record<string, unknown>>;
  readonly flags: Readonly<Record<string, unknown>>;
  readonly cwd: string;
  readonly app?: {
    readonly kind: "user" | "global" | "scratch";
    readonly id: string;
    readonly root: string;
  };
  readonly invocationId?: string;
  readonly parentInvocationId?: string;
}

export interface CommandLifecycleOptions<A> {
  readonly invocation: CliInvocationSnapshot;
  readonly successExitCode?: (value: A) => number | undefined;
  readonly failureExitCode?: (error: unknown) => number | undefined;
  readonly interruptionExitCode?: number;
  /** Runs after the init event is published and before the command starts. */
  readonly onInitialized?: Effect.Effect<void>;
}

const CurrentCommandInvocation = Context.Reference<CliInvocationSnapshot | undefined>(
  "@lando/core/CurrentCommandInvocation",
  {
    defaultValue: () => undefined,
  },
);

export interface NestedCommandInvocationInput {
  readonly argv: ReadonlyArray<string>;
  readonly args: Readonly<Record<string, unknown>>;
  readonly flags: Readonly<Record<string, unknown>>;
  readonly cwd?: string;
}

export const makeNestedCommandInvocation = (
  commandId: string,
  input: NestedCommandInvocationInput,
): Effect.Effect<CliInvocationSnapshot> =>
  CurrentCommandInvocation.pipe(
    Effect.map((parent) => ({
      commandId,
      argv: input.argv,
      args: input.args,
      flags: input.flags,
      cwd: input.cwd ?? parent?.cwd ?? process.cwd(),
      invocationId: newInvocationId(),
      ...(parent?.invocationId === undefined ? {} : { parentInvocationId: parent.invocationId }),
    })),
  );

export const newInvocationId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replaceAll("-", "");
  }
  return `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
};

export const withCommandEventService = <A, E, R>(
  effect: Effect.Effect<A, E, R | EventService>,
): Effect.Effect<A, E, R> =>
  Effect.serviceOption(EventService).pipe(
    Effect.flatMap((eventService) =>
      Option.isSome(eventService)
        ? effect.pipe(Effect.provideService(EventService, eventService.value))
        : effect.pipe(Effect.provide(LandoEventService.layer)),
    ),
  );

const failureIdentity = (cause: Cause.Cause<unknown>): { readonly failureTag: string } => {
  if (Cause.hasInterruptsOnly(cause)) return { failureTag: "Interrupted" };
  const failure = Cause.findErrorOption(cause);
  if (failure._tag === "Some") {
    const value = failure.value;
    if (typeof value === "object" && value !== null) {
      const failureTag = "_tag" in value && typeof value._tag === "string" ? value._tag : "Failure";
      return { failureTag };
    }
    return { failureTag: "Failure" };
  }
  if (Cause.hasDies(cause)) return { failureTag: "Defect" };
  return { failureTag: "Failure" };
};

const publishRedacted = Effect.fnUntraced(
  function* <A extends LandoEvent, I>(schema: Schema.Codec<A, I>, event: I) {
    const redaction = yield* RedactionService;
    const events = yield* EventService;
    const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
    const decoded = yield* Schema.decodeUnknownEffect(schema)(redactor.redactValue(event));
    yield* events.publish(decoded);
  },
  Effect.catchCause((cause) =>
    Effect.serviceOption(Logger).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (logger) =>
            logger
              .debug("CLI lifecycle event publication failed.", { cause: Cause.pretty(cause) })
              .pipe(Effect.catch(() => Effect.void)),
        }),
      ),
    ),
  ),
);

export const runCommandLifecycle: <A, E, R>(
  command: Effect.Effect<A, E, R>,
  options: CommandLifecycleOptions<A>,
) => Effect.Effect<Exit.Exit<A, E>, never, R | RedactionService> = Effect.fnUntraced(function* <A, E, R>(
  command: Effect.Effect<A, E, R>,
  options: CommandLifecycleOptions<A>,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const invocationId = options.invocation.invocationId ?? newInvocationId();
  const parentInvocationId = options.invocation.parentInvocationId;
  const invocationSnapshot: CliInvocationSnapshot = {
    ...options.invocation,
    invocationId,
  };
  const invocation = {
    commandId: options.invocation.commandId,
    argv: summarizeInvocationArgv(options.invocation.argv),
    args: summarizeInvocationRecord(options.invocation.args),
    flags: summarizeInvocationRecord(options.invocation.flags),
    cwd: options.invocation.cwd,
    ...(options.invocation.app === undefined ? {} : { app: options.invocation.app }),
    invocationId,
    ...(parentInvocationId === undefined ? {} : { parentInvocationId }),
    timestamp: DateTime.formatIso(DateTime.makeUnsafe(startedAt)),
  };
  yield* publishRedacted(CliCommandInitEvent, {
    _tag: `cli-${options.invocation.commandId}-init`,
    ...invocation,
  });
  if (options.onInitialized !== undefined) yield* options.onInitialized;
  const outcome = yield* Effect.exit(command).pipe(
    Effect.provideService(CurrentCommandInvocation, invocationSnapshot),
  );
  const finishedAt = yield* Clock.currentTimeMillis;
  const terminal = {
    ...invocation,
    timestamp: DateTime.formatIso(DateTime.makeUnsafe(finishedAt)),
    durationMs: Math.max(0, finishedAt - startedAt),
  };
  if (Exit.isSuccess(outcome)) {
    yield* publishRedacted(CliCommandRunEvent, {
      _tag: `cli-${options.invocation.commandId}-run`,
      ...terminal,
      exitCode: options.successExitCode?.(outcome.value) ?? 0,
    });
  } else {
    const failure = Cause.findErrorOption(outcome.cause);
    yield* publishRedacted(CliCommandErrorEvent, {
      _tag: `cli-${options.invocation.commandId}-error`,
      ...terminal,
      exitCode: Cause.hasInterruptsOnly(outcome.cause)
        ? (options.interruptionExitCode ?? 1)
        : failure._tag === "Some"
          ? (options.failureExitCode?.(failure.value) ?? 1)
          : 1,
      ...failureIdentity(outcome.cause),
    });
  }
  return outcome;
}, withCommandEventService);
