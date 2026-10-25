import { Cause, Clock, Context, DateTime, Effect, Exit, Option, Schema } from "effect";

import {
  type CompletedCommandResult,
  failureOutcomeFromCause,
  internalError,
  resolveCommandCompletion,
} from "@lando/sdk/command-result";
import { CliCommandErrorEvent, CliCommandInitEvent, CliCommandRunEvent } from "@lando/sdk/events";
import type { CommandCompletion } from "@lando/sdk/schema";
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
  readonly completion?: (value: A) => CommandCompletion;
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
  return `inv_${DateTime.toEpochMillis(DateTime.nowUnsafe()).toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
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

const failureIdentity = (
  cause: Cause.Cause<unknown>,
): Pick<CliCommandErrorEvent, "failureTag" | "additionalFailures"> => {
  if (Cause.hasInterruptsOnly(cause)) return { failureTag: "Interrupted" };
  const failure = failureOutcomeFromCause(cause, internalError);
  const tagOf = (value: unknown): string =>
    typeof value === "object" && value !== null && "_tag" in value && typeof value._tag === "string"
      ? value._tag
      : cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === value)
        ? "Defect"
        : "Failure";
  const additionalFailures = failure.additionalErrors.map(({ error, role }) => ({
    failureTag: tagOf(error),
    role,
  }));
  const [first, ...rest] = additionalFailures;
  return {
    failureTag: tagOf(failure.error),
    ...(first === undefined ? {} : { additionalFailures: [first, ...rest] }),
  };
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
) => Effect.Effect<Exit.Exit<CompletedCommandResult<A>, E>, never, R | RedactionService> = Effect.fnUntraced(
  function* <A, E, R>(command: Effect.Effect<A, E, R>, options: CommandLifecycleOptions<A>) {
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
    const outcome = yield* Effect.exit(
      command.pipe(
        Effect.scoped,
        Effect.map((value) =>
          resolveCommandCompletion(options.invocation.commandId, value, options.completion),
        ),
      ),
    ).pipe(Effect.provideService(CurrentCommandInvocation, invocationSnapshot));
    const finishedAt = yield* Clock.currentTimeMillis;
    const terminal = {
      ...invocation,
      timestamp: DateTime.formatIso(DateTime.makeUnsafe(finishedAt)),
      durationMs: Math.max(0, finishedAt - startedAt),
    };
    if (Exit.isSuccess(outcome)) {
      if (outcome.value._tag === "failure") {
        yield* publishRedacted(CliCommandErrorEvent, {
          _tag: `cli-${options.invocation.commandId}-error`,
          ...terminal,
          exitCode: outcome.value.exitCode,
          failureTag: "LandoCommandError",
        });
        return outcome;
      }
      yield* publishRedacted(CliCommandRunEvent, {
        _tag: `cli-${options.invocation.commandId}-run`,
        ...terminal,
        exitCode: outcome.value.exitCode,
      });
    } else {
      const failure = failureOutcomeFromCause(outcome.cause, internalError);
      yield* publishRedacted(CliCommandErrorEvent, {
        _tag: `cli-${options.invocation.commandId}-error`,
        ...terminal,
        exitCode: Cause.hasInterruptsOnly(outcome.cause)
          ? (options.interruptionExitCode ?? 1)
          : (options.failureExitCode?.(failure.error) ?? 1),
        ...failureIdentity(outcome.cause),
      });
    }
    return outcome;
  },
  withCommandEventService,
);
