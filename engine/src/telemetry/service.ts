import { Context, Duration, Effect, Layer, Option, Queue, type Scope, Stream } from "effect";

import { Telemetry } from "@lando/sdk/services";

import { makeLibraryTelemetry } from "../runtime/bootstrap-layer-support.ts";
import { redactTelemetryData } from "./redaction.ts";

export interface TelemetryRecord {
  readonly event: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface TelemetrySink {
  readonly id: string;
  readonly record: (event: string, data: Readonly<Record<string, unknown>>) => Effect.Effect<void, unknown>;
}

export class TelemetrySinks extends Context.Tag("@lando/core/TelemetrySinks")<
  TelemetrySinks,
  ReadonlyArray<TelemetrySink>
>() {}

export interface TelemetryTransportOptions {
  readonly capacity?: number;
  readonly flushBudgetMillis?: number;
}

const DEFAULT_CAPACITY = 256;
const DEFAULT_FLUSH_BUDGET_MILLIS = 2000;

const dispatchRecord = (
  sinks: ReadonlyArray<TelemetrySink>,
  sinkTimeout: Duration.Duration,
  record: TelemetryRecord,
): Effect.Effect<void> =>
  Effect.forEach(
    sinks,
    (sink) =>
      sink.record(record.event, record.data).pipe(
        Effect.timeout(sinkTimeout),
        Effect.catchAllCause(() => Effect.void),
      ),
    { discard: true },
  );

const makeTransport = (
  sinks: ReadonlyArray<TelemetrySink>,
  options: TelemetryTransportOptions | undefined,
): Effect.Effect<Context.Tag.Service<typeof Telemetry>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const capacity = options?.capacity ?? DEFAULT_CAPACITY;
    const budget = Duration.millis(options?.flushBudgetMillis ?? DEFAULT_FLUSH_BUDGET_MILLIS);
    const queue = yield* Queue.dropping<TelemetryRecord>(capacity);

    yield* Stream.fromQueue(queue).pipe(
      Stream.runForEach((record) => dispatchRecord(sinks, budget, record)),
      Effect.catchAllCause(() => Effect.void),
      Effect.forkScoped,
    );

    // Finalizers run uninterruptibly, which would mask the timeout below and
    // let a hanging sink delay shutdown forever. `Effect.interruptible`
    // re-enables interruption so the bounded flush can actually time out.
    yield* Effect.addFinalizer(() =>
      Effect.interruptible(
        Queue.takeAll(queue).pipe(
          Effect.flatMap((records) =>
            Effect.forEach(records, (record) => dispatchRecord(sinks, budget, record), { discard: true }),
          ),
          Effect.timeout(budget),
        ),
      ).pipe(Effect.catchAllCause(() => Effect.void)),
    );

    return {
      enabled: true,
      record: (event, data) =>
        event.length === 0
          ? Effect.void
          : Queue.offer(queue, { event, data: redactTelemetryData(event, data) }).pipe(Effect.asVoid),
    };
  });

export const makeTelemetryLayer = (
  enabled: boolean,
  options?: TelemetryTransportOptions,
): Layer.Layer<Telemetry> =>
  enabled
    ? Layer.scoped(
        Telemetry,
        Effect.flatMap(Effect.serviceOption(TelemetrySinks), (sinks) =>
          makeTransport(
            Option.getOrElse(sinks, () => []),
            options,
          ),
        ),
      )
    : Layer.succeed(Telemetry, makeLibraryTelemetry(false));
