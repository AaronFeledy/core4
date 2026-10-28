import { ServiceExecError } from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";
import type { AppPlan } from "@lando/sdk/schema";
import type { ExecTarget, ProviderError } from "@lando/sdk/services";
import { Cause, Deferred, Duration, Effect, Fiber, Queue, Stream } from "effect";
import type { EngineHttpApi, ProviderErrorContext } from "./engine-api.ts";
import { ExecWatchAttachDecoder, ExecWatchProtocol, type ExecWatchReceipt } from "./exec-watch-protocol.ts";
import { execStream as transportExecStream } from "./podman/exec-transport.ts";

export interface OwnedExecWatch {
  readonly ready: Effect.Effect<void, ProviderError>;
  /** Completes only after strict EOF validation and the known-started watch exits zero. */
  readonly finished: Effect.Effect<ExecWatchReceipt, ProviderError>;
  readonly resumeAfterLaunch: Effect.Effect<void, ProviderError>;
  readonly prepareCancel: Effect.Effect<void>;
  /** Call only after the requested cancellation has been persisted. */
  readonly resumeAfterCancel: Effect.Effect<void>;
  readonly stopBeforeStart: Effect.Effect<boolean>;
  readonly stopInput: Effect.Effect<void>;
  readonly join: Effect.Effect<void, ProviderError>;
  readonly failureCause: () => Cause.Cause<ProviderError> | undefined;
  readonly interruptUnsafe: () => void;
}

interface WatchOptions {
  readonly api: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
  readonly container: string;
  readonly helperPath: string;
  readonly directory: string;
  readonly nonce: string;
  readonly inspectExit: (id: string) => Effect.Effect<number, ProviderError>;
  readonly acquire: (watch: OwnedExecWatch) => void;
}

/** One private exec and one bounded, stop-and-wait heartbeat producer per command. */
export const startExecWatch = (
  plan: AppPlan,
  target: ExecTarget,
  options: WatchOptions,
): Effect.Effect<OwnedExecWatch> =>
  Effect.gen(function* () {
    const failure = (stage: string, cause?: unknown) =>
      new ServiceExecError({
        providerId: options.ctx.providerId,
        operation: "exec",
        service: target.service,
        message: `Container command supervision failed (${stage}).`,
        ...(cause === undefined ? {} : { cause }),
        remediation:
          "Check the service container and provider connection before retrying. If cleanup could not be confirmed, restart the service.",
      });
    const started = yield* Deferred.make<void, ProviderError>();
    const ready = yield* Deferred.make<void, ProviderError>();
    const finished = yield* Deferred.make<ExecWatchReceipt, ProviderError>();
    const resume = yield* Deferred.make<void>();
    const stop = yield* Deferred.make<void>();
    const input = yield* Queue.bounded<Uint8Array, Cause.Done>(1);
    let pending: Deferred.Deferred<ExecWatchReceipt, ProviderError> | undefined;
    let watchStarted = false;
    let watchExited = false;
    let watchId: string | undefined;
    let finalReceipt: ExecWatchReceipt | undefined;
    let observedFailure: Cause.Cause<ProviderError> | undefined;
    let creationStopped = false;
    const fibers: { producer?: Fiber.Fiber<void, never>; attached?: Fiber.Fiber<void, never> } = {};
    const protocol = new ExecWatchProtocol((receipt) => {
      if (!watchStarted || pending === undefined) throw failure("watch-reply-before-start");
      Deferred.doneUnsafe(pending, Effect.succeed(receipt));
      if (receipt.state === "ready") Deferred.doneUnsafe(ready, Effect.void);
    });
    const decode = new ExecWatchAttachDecoder(protocol);
    const stopInput = Deferred.succeed(stop, undefined).pipe(Effect.andThen(Queue.end(input)), Effect.asVoid);
    const handle: OwnedExecWatch = {
      ready: Deferred.await(ready),
      finished: Deferred.await(finished),
      resumeAfterLaunch: Effect.try({
        try: () => protocol.markLaunched(),
        catch: (cause) => failure("watch-launch-order", cause),
      }).pipe(Effect.andThen(Deferred.succeed(resume, undefined)), Effect.asVoid),
      prepareCancel: Effect.sync(() => protocol.beginCancel()),
      resumeAfterCancel: Deferred.succeed(resume, undefined).pipe(Effect.asVoid),
      stopInput,
      stopBeforeStart: Effect.gen(function* () {
        if (watchId !== undefined) return false;
        creationStopped = true;
        yield* stopInput;
        yield* Effect.sync(() => fibers.attached?.interruptUnsafe());
        if (fibers.attached !== undefined) yield* Fiber.await(fibers.attached);
        return watchId === undefined;
      }),
      join: Effect.gen(function* () {
        if (fibers.producer !== undefined) yield* Fiber.await(fibers.producer);
        if (fibers.attached !== undefined) yield* Fiber.await(fibers.attached);
        if (watchExited || (creationStopped && watchId === undefined)) return;
        if (!watchStarted || watchId === undefined)
          return yield* Effect.fail(failure("watch-start-uncertain"));
        let stopped = false;
        let lastFailure: ProviderError | undefined;
        const result = yield* runProbe(
          {
            id: "exec-watch-stop",
            policy: { maxAttempts: 40, delay: Duration.millis(100), timeout: Duration.millis(3500) },
          },
          options.inspectExit(watchId).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                stopped = true;
              }),
            ),
            Effect.tapError((error) =>
              Effect.sync(() => {
                lastFailure = error;
              }),
            ),
          ),
        );
        if (result.outcome !== "green" || !stopped)
          return yield* Effect.fail(failure("watch-stop-unconfirmed", lastFailure));
      }).pipe(Effect.mapError((cause) => failure("watch-stop-unconfirmed", cause))),
      failureCause: () => observedFailure,
      interruptUnsafe: () => {
        Deferred.doneUnsafe(stop, Effect.void);
        Queue.endUnsafe(input);
        fibers.producer?.interruptUnsafe();
        fibers.attached?.interruptUnsafe();
      },
    };
    // Publish ownership before either background operation can perform provider IO.
    options.acquire(handle);
    const heartbeat = Effect.gen(function* () {
      yield* Deferred.await(started);
      let first = true;
      for (;;) {
        if (!first) {
          yield* Deferred.await(resume);
          yield* Effect.sleep("500 millis");
        }
        first = false;
        pending = yield* Deferred.make<ExecWatchReceipt, ProviderError>();
        const bytes = yield* Effect.try({
          try: () => protocol.request(),
          catch: (cause) => failure("watch-request-order", cause),
        });
        yield* Queue.offer(input, bytes);
        const receipt = yield* Deferred.await(pending).pipe(
          Effect.timeout("2 seconds"),
          Effect.mapError((cause) => failure("watch-heartbeat", cause)),
        );
        if (receipt.joined === true) return;
      }
    }).pipe(Effect.raceFirst(Deferred.await(stop)));
    const produce = Effect.exit(heartbeat).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          yield* Queue.end(input);
          if (exit._tag === "Failure") {
            if (!creationStopped || !Cause.hasInterruptsOnly(exit.cause)) observedFailure ??= exit.cause;
            yield* Deferred.failCause(ready, exit.cause);
            yield* Deferred.failCause(finished, exit.cause);
          }
        }),
      ),
    );
    const stdin = yield* Stream.toAsyncIterableEffect(Stream.fromQueue(input));
    const observe = Effect.scoped(
      transportExecStream(
        plan,
        target,
        {
          command: [options.helperPath, "exec-control", options.directory, options.nonce, "watch"],
          raw: true,
          stdinStream: stdin,
        },
        {
          api: options.api,
          ctx: options.ctx,
          raw: true,
          containerId: options.container,
          onExecCreated: (id) => {
            watchId = id;
          },
          onExecStarted: () => {
            watchStarted = true;
            Deferred.doneUnsafe(started, Effect.void);
          },
          validateAttach: {
            feed: (bytes) => decode.feed(bytes),
            end: () => {
              finalReceipt = decode.end();
            },
          },
        },
      ).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            if (!("exitCode" in chunk)) return;
            if (!watchStarted || watchId === undefined || chunk.exitCode !== 0 || finalReceipt === undefined)
              return yield* Effect.fail(failure("watch-exit-unconfirmed"));
            if ((yield* options.inspectExit(watchId)) !== 0)
              return yield* Effect.fail(failure("watch-exit-nonzero"));
            watchExited = true;
          }),
        ),
        Effect.andThen(
          Effect.gen(function* () {
            if (finalReceipt === undefined || !watchStarted || !watchExited || watchId === undefined)
              return yield* Effect.fail(failure("watch-terminal-missing"));
            if (fibers.producer !== undefined) yield* Fiber.await(fibers.producer);
            return finalReceipt;
          }),
        ),
      ),
    );
    const watch = Effect.exit(observe).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          yield* stopInput;
          yield* Deferred.done(finished, exit);
          if (exit._tag === "Failure") {
            if (!creationStopped || !Cause.hasInterruptsOnly(exit.cause)) observedFailure ??= exit.cause;
            yield* Deferred.failCause(ready, exit.cause);
            yield* Deferred.failCause(started, exit.cause);
            if (pending !== undefined) yield* Deferred.failCause(pending, exit.cause);
          }
        }),
      ),
    );
    fibers.producer = yield* produce.pipe(Effect.interruptible, Effect.forkDetach);
    fibers.attached = yield* watch.pipe(Effect.interruptible, Effect.forkDetach);
    return handle;
  }).pipe(Effect.uninterruptible);
