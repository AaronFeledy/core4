import { annotateFailureRole, failureDefectCause } from "@lando/sdk/command-result";
import { ProviderUnavailableError, ServiceExecError } from "@lando/sdk/errors";
import type { AppPlan, ContainerHelperTarget } from "@lando/sdk/schema";
import type { CommandSpec, ExecChunk, ExecTarget, ProviderError } from "@lando/sdk/services";
import { type Cause, Deferred, Effect, Exit, Fiber, Queue, Schema, type Scope, Stream } from "effect";
import { containerHelperDelivery } from "./container-helper.ts";
import type { EngineHttpApi, ProviderErrorContext } from "./engine-api.ts";
import { cancelWedgedExec } from "./exec-cancellation.ts";
import { execDataFrames, execEofFrame, execSignalFrame } from "./exec-control.ts";
import type { ResolveContainerHelper } from "./log-source-binding.ts";
import { serviceContainerName } from "./plan.ts";
import { interruptOnSignal, execStream as transportExecStream } from "./podman/exec-transport.ts";

export interface ExecSupervisionOptions {
  readonly api?: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
  readonly resolveContainerHelper?: ResolveContainerHelper | undefined;
  readonly helperTarget?: ContainerHelperTarget | undefined;
  readonly prepareCommand?: (
    containerId: string,
  ) => Effect.Effect<{ readonly command: CommandSpec; readonly umask?: string }, ProviderError, Scope.Scope>;
}

const Container = Schema.Struct({
  Id: Schema.NonEmptyString,
  Mounts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        Source: Schema.String,
        Destination: Schema.String,
        RW: Schema.Boolean,
      }),
    ),
  ),
});

/** The detached attach stays owned until cancellation has joined the helper. */
export const supervisedExecStream = (
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
  options: ExecSupervisionOptions,
): Stream.Stream<ExecChunk, ProviderError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const failure = (stage: string, cause?: unknown) =>
        new ServiceExecError({
          providerId: options.ctx.providerId,
          operation: "exec",
          service: target.service,
          message: `Container command supervision failed (${stage}).`,
          remediation:
            stage === "helper-mount-missing"
              ? "Run lando start to recreate the service with its container helper mount, then retry."
              : "Check the service container and provider connection, then retry.",
          ...(cause === undefined ? {} : { cause }),
        });
      const { api, resolveContainerHelper, helperTarget } = options;
      if (
        api?.request === undefined ||
        api.stream === undefined ||
        resolveContainerHelper === undefined ||
        helperTarget === undefined
      )
        return yield* Effect.fail(failure("helper-unavailable"));
      if (command.signal?.aborted) return yield* Effect.interrupt;
      const request = api.request;
      const response = yield* request({
        method: "GET",
        path: `/containers/${encodeURIComponent(serviceContainerName(plan, target.service))}/json`,
      });
      if (response.status < 200 || response.status >= 300)
        return yield* Effect.fail(failure("container-inspect"));
      const container = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Container))(
        response.body,
      ).pipe(Effect.mapError((cause) => failure("container-inspect", cause)));
      const helper = yield* resolveContainerHelper(helperTarget).pipe(
        Effect.mapError(
          (cause) =>
            new ServiceExecError({
              providerId: options.ctx.providerId,
              operation: "exec",
              service: target.service,
              message: cause.message,
              remediation: cause.remediation,
              cause,
            }),
        ),
      );
      const delivery = containerHelperDelivery(helper);
      if (
        !container.Mounts?.some(
          (mount) => mount.Destination === delivery.target && mount.Source === delivery.source && !mount.RW,
        )
      )
        return yield* Effect.fail(failure("helper-mount-missing"));
      const preparation =
        options.prepareCommand === undefined ? { command } : yield* options.prepareCommand(container.Id);
      const prepared = preparation.command;
      const nonce = yield* Effect.sync(() =>
        Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"),
      );
      const input = yield* Queue.bounded<Uint8Array, Cause.Done>(1);
      const output = yield* Queue.bounded<ExecChunk, ProviderError | Cause.Done>(16);
      const finished = yield* Deferred.make<void, ProviderError>();
      const frames = yield* Stream.toAsyncIterableEffect(Stream.fromQueue(input));
      const signalWritten = Promise.withResolvers<void>();
      let cancelFrame: Uint8Array | undefined;
      const stdin = {
        async *[Symbol.asyncIterator]() {
          for await (const frame of frames) {
            yield frame;
            if (frame === cancelFrame) signalWritten.resolve();
          }
        },
      };
      const disconnect = new AbortController();
      let completed = false;
      let execId: string | undefined;
      const owned: { producer?: Fiber.Fiber<void, never>; attach?: Fiber.Fiber<void, never> } = {};
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (owned.producer !== undefined) yield* Fiber.interrupt(owned.producer);
          const drain = yield* Stream.runDrain(Stream.fromQueue(output)).pipe(
            Effect.ignore,
            Effect.forkDetach,
          );
          const cleanup = Effect.gen(function* () {
            if (completed || execId === undefined) return;
            yield* Queue.clear(input);
            cancelFrame = execSignalFrame(command.signal);
            const joined = yield* Effect.exit(
              Queue.offer(input, cancelFrame).pipe(
                Effect.andThen(Effect.promise(() => signalWritten.promise)),
                Effect.timeout("250 millis"),
                Effect.andThen(Deferred.await(finished)),
                Effect.interruptible,
                Effect.timeout("4 seconds"),
              ),
            );
            if (Exit.isSuccess(joined)) return;
            disconnect.abort();
            const unavailable = (cause?: unknown) =>
              new ProviderUnavailableError({
                providerId: options.ctx.providerId,
                operation: "exec",
                message: "Could not observe the container exec after disconnecting its control channel.",
                remediation: "Check the provider connection and service processes before retrying.",
                ...(cause === undefined ? {} : { cause }),
              });
            yield* cancelWedgedExec({
              api,
              ctx: options.ctx,
              plan,
              target,
              containerId: container.Id,
              helper: delivery.executable,
              nonce,
              signal: command.signal,
              execId,
            }).pipe(
              Effect.interruptible,
              Effect.timeout("1500 millis"),
              Effect.catchTag("TimeoutError", (cause) => Effect.fail(unavailable(cause))),
            );
          });
          const result = yield* Effect.exit(cleanup);
          disconnect.abort();
          if (owned.attach !== undefined) yield* Fiber.interrupt(owned.attach);
          yield* Fiber.interrupt(drain);
          yield* Queue.shutdown(input);
          yield* Queue.shutdown(output);
          if (Exit.isFailure(result))
            return yield* Effect.failCause(failureDefectCause(annotateFailureRole(result.cause, "cleanup")));
        }),
      );
      owned.producer = yield* Effect.gen(function* () {
        if (prepared.stdinStream !== undefined) {
          yield* Stream.fromAsyncIterable(prepared.stdinStream, (cause) => failure("stdin", cause)).pipe(
            Stream.runForEach((bytes) =>
              Effect.gen(function* () {
                for (const frame of execDataFrames(bytes)) yield* Queue.offer(input, frame);
              }),
            ),
          );
        }
        yield* Queue.offer(input, execEofFrame());
      }).pipe(
        Effect.catch((error) => Queue.fail(output, error)),
        Effect.asVoid,
        Effect.forkDetach,
      );
      const { signal: _signal, ...payload } = prepared;
      owned.attach = yield* Effect.scoped(
        transportExecStream(
          plan,
          target,
          {
            ...payload,
            command: [
              delivery.executable,
              "exec-run",
              "--nonce",
              nonce,
              ...(preparation.umask === undefined ? [] : ["--umask", preparation.umask]),
              "--",
              ...prepared.command,
            ],
            raw: true,
            tty: false,
            stdinStream: stdin,
            signal: disconnect.signal,
          },
          {
            api,
            ctx: options.ctx,
            raw: true,
            containerId: container.Id,
            onExecCreated: (id) => {
              execId = id;
            },
          },
        ).pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              if ("exitCode" in chunk) completed = true;
              yield* Queue.offer(output, chunk);
            }),
          ),
        ),
      ).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            yield* Deferred.done(finished, exit);
            if (Exit.isFailure(exit)) yield* Queue.failCause(output, exit.cause);
            else yield* Queue.end(output);
          }),
        ),
        Effect.ignore,
        Effect.forkDetach,
      );
      return Stream.fromQueue(output).pipe(
        Stream.interruptWhen(interruptOnSignal(command.signal).pipe(Effect.andThen(Effect.interrupt))),
      );
    }),
  );
