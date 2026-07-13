import { Cause, Clock, Effect, Exit, Option, Schema } from "effect";

import { CliCommandErrorEvent, CliCommandInitEvent, CliCommandRunEvent } from "@lando/sdk/events";
import { EventService, type LandoEvent, Logger } from "@lando/sdk/services";

import { RedactionService } from "../redaction/service.ts";
import { EventServiceLive } from "../services/event-service.ts";
import { summarizeInvocationArgv, summarizeInvocationRecord } from "./invocation-summary.ts";

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
}

export interface CommandLifecycleOptions<A> {
  readonly invocation: CliInvocationSnapshot;
  readonly successExitCode?: (value: A) => number | undefined;
  readonly interruptionExitCode?: number;
}

export const withCommandEventService = <A, E, R>(
  effect: Effect.Effect<A, E, R | EventService>,
): Effect.Effect<A, E, R> =>
  Effect.serviceOption(EventService).pipe(
    Effect.flatMap((eventService) =>
      Option.isSome(eventService)
        ? effect.pipe(Effect.provideService(EventService, eventService.value))
        : effect.pipe(Effect.provide(EventServiceLive)),
    ),
  );

const failureIdentity = (cause: Cause.Cause<unknown>): { readonly failureTag: string } => {
  if (Cause.isInterruptedOnly(cause)) return { failureTag: "Interrupted" };
  const failure = Cause.failureOption(cause);
  if (failure._tag === "Some") {
    const value = failure.value;
    if (typeof value === "object" && value !== null) {
      const failureTag = "_tag" in value && typeof value._tag === "string" ? value._tag : "Failure";
      return { failureTag };
    }
    return { failureTag: "Failure" };
  }
  const defect = Cause.dieOption(cause);
  if (defect._tag === "Some") return { failureTag: "Defect" };
  return { failureTag: "Failure" };
};

const publishRedacted = <A extends LandoEvent, I>(schema: Schema.Schema<A, I>, event: I) =>
  Effect.gen(function* () {
    const redaction = yield* RedactionService;
    const events = yield* EventService;
    const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
    const decoded = yield* Schema.decodeUnknown(schema)(redactor.redactValue(event));
    yield* events.publish(decoded);
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.serviceOption(Logger).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (logger) =>
              logger
                .debug("CLI lifecycle event publication failed.", { cause: Cause.pretty(cause) })
                .pipe(Effect.catchAll(() => Effect.void)),
          }),
        ),
      ),
    ),
  );

export const runCommandLifecycle = <A, E, R>(
  command: Effect.Effect<A, E, R>,
  options: CommandLifecycleOptions<A>,
): Effect.Effect<Exit.Exit<A, E>, never, R | RedactionService> =>
  withCommandEventService(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const invocation = {
        ...options.invocation,
        argv: summarizeInvocationArgv(options.invocation.argv),
        args: summarizeInvocationRecord(options.invocation.args),
        flags: summarizeInvocationRecord(options.invocation.flags),
        timestamp: new Date(startedAt).toISOString(),
      };
      yield* publishRedacted(CliCommandInitEvent, {
        _tag: `cli-${options.invocation.commandId}-init`,
        ...invocation,
      });
      const outcome = yield* Effect.exit(command);
      const finishedAt = yield* Clock.currentTimeMillis;
      const terminal = {
        ...invocation,
        timestamp: new Date(finishedAt).toISOString(),
        durationMs: Math.max(0, finishedAt - startedAt),
      };
      if (Exit.isSuccess(outcome)) {
        yield* publishRedacted(CliCommandRunEvent, {
          _tag: `cli-${options.invocation.commandId}-run`,
          ...terminal,
          exitCode: options.successExitCode?.(outcome.value) ?? 0,
        });
      } else {
        yield* publishRedacted(CliCommandErrorEvent, {
          _tag: `cli-${options.invocation.commandId}-error`,
          ...terminal,
          exitCode: Cause.isInterruptedOnly(outcome.cause) ? (options.interruptionExitCode ?? 1) : 1,
          ...failureIdentity(outcome.cause),
        });
      }
      return outcome;
    }),
  );
