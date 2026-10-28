import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { annotateFailureRole, failureDefectCause } from "@lando/sdk/command-result";
import { ServiceExecError } from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";
import type { AppPlan, ContainerHelperTarget } from "@lando/sdk/schema";
import type { CommandSpec, ExecChunk, ExecTarget, ProviderError } from "@lando/sdk/services";
import { type Cause, Deferred, Duration, Effect, Fiber, Queue, Stream } from "effect";
import type { EngineHttpApi, EngineHttpRequest, ProviderErrorContext } from "./engine-api.ts";
import { installExecHelper } from "./exec-helper-install.ts";
import type { ResolveContainerHelper } from "./log-source-binding.ts";
import { serviceContainerName } from "./plan.ts";
import { execStream as transportExecStream } from "./podman/exec-transport.ts";
import { makeAttachDecoder } from "./streams.ts";

export interface ExecSupervisionOptions {
  readonly api?: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
  readonly resolveContainerHelper?: ResolveContainerHelper | undefined;
  readonly helperTarget?: ContainerHelperTarget | undefined;
}
interface Receipt {
  readonly state: "initialized" | "ready" | "running" | "finished" | "cancelled" | "collected";
  readonly exitCode?: number;
  readonly joined?: boolean;
}
const decoder = new TextDecoder();
const signalName = (signal: AbortSignal | undefined) => (signal?.reason === "SIGINT" ? "SIGINT" : "SIGTERM");

/** Owns the helper and its attach until the selected user's entire command tree joins. */
export const supervisedExecStream = (
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
  options: ExecSupervisionOptions,
): Stream.Stream<ExecChunk, ProviderError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const failure = (
        stage: string,
        details?: { readonly status?: number; readonly category?: string; readonly helperCode?: string },
        cause?: unknown,
      ) =>
        new ServiceExecError({
          providerId: options.ctx.providerId,
          operation: "exec",
          service: target.service,
          message: `Container command supervision failed (${stage}).`,
          ...(details === undefined ? {} : { details }),
          ...(cause === undefined ? {} : { cause }),
          remediation:
            "Check the service container and provider connection before retrying. If cleanup could not be confirmed, restart the service.",
        });
      const api = options.api;
      const resolveHelper = options.resolveContainerHelper;
      const helperTarget = options.helperTarget;
      if (
        api?.request === undefined ||
        api.stream === undefined ||
        resolveHelper === undefined ||
        helperTarget === undefined
      )
        return yield* Effect.fail(failure("helper-unavailable"));
      if (command.signal?.aborted) return yield* Effect.fail(failure("cancelled-before-start"));
      const abortBeforeOwnership =
        command.signal === undefined
          ? Effect.never
          : Effect.callback<never>((resume) => {
              const signal = command.signal;
              if (signal === undefined) return;
              if (signal.aborted) {
                resume(Effect.interrupt);
                return;
              }
              const onAbort = () => resume(Effect.interrupt);
              signal.addEventListener("abort", onAbort, { once: true });
              return Effect.sync(() => signal.removeEventListener("abort", onAbort));
            });
      const beforeOwnership = <A>(effect: Effect.Effect<A, ProviderError>) =>
        effect.pipe(
          Effect.timeout("10 seconds"),
          Effect.mapError((error) =>
            error._tag === "TimeoutError" ? failure("acquisition-timeout", undefined, error) : error,
          ),
          Effect.raceFirst(abortBeforeOwnership),
        );
      const requestApi = api.request;
      const streamApi = api.stream;
      const request = (input: EngineHttpRequest) =>
        requestApi(input).pipe(
          Effect.flatMap((response) =>
            response.status >= 200 && response.status < 300
              ? Effect.succeed(response)
              : Effect.fail(failure("provider-request", { status: response.status })),
          ),
        );
      const inspect = yield* beforeOwnership(
        request({
          method: "GET",
          path: `/containers/${encodeURIComponent(serviceContainerName(plan, target.service))}/json`,
        }),
      );
      let container: string;
      try {
        const value = JSON.parse(inspect.body) as { Id?: unknown };
        if (typeof value.Id !== "string" || value.Id.length === 0)
          return yield* Effect.fail(failure("container-identity"));
        container = value.Id;
      } catch {
        return yield* Effect.fail(failure("container-identity"));
      }
      const helper = yield* beforeOwnership(
        resolveHelper(helperTarget).pipe(
          Effect.mapError(
            (error) =>
              new ServiceExecError({
                providerId: options.ctx.providerId,
                operation: "exec",
                service: target.service,
                message: error.message,
                remediation: error.remediation,
                details: { category: error._tag },
              }),
          ),
        ),
      );
      if (helper.target.os !== helperTarget.os || helper.target.arch !== helperTarget.arch)
        return yield* Effect.fail(failure("helper-architecture"));
      const bytes = yield* beforeOwnership(
        Effect.tryPromise({
          try: () => readFile(helper.path),
          catch: () => failure("helper-read"),
        }),
      );
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== helper.digest) return yield* Effect.fail(failure("helper-digest"));
      const helperPath = yield* beforeOwnership(
        installExecHelper(api, options.ctx, container, { bytes, digest }),
      );
      const nonce = randomBytes(16).toString("hex");
      const directory = `/tmp/lando-exec-session-${nonce}`;
      const inspectExit = (id: string) =>
        request({ method: "GET", path: `/exec/${encodeURIComponent(id)}/json` }).pipe(
          Effect.flatMap((response) => {
            try {
              const state = JSON.parse(response.body) as { Running?: unknown; ExitCode?: unknown };
              return state.Running === false &&
                typeof state.ExitCode === "number" &&
                Number.isInteger(state.ExitCode)
                ? Effect.succeed(state.ExitCode)
                : Effect.fail(failure("exec-not-joined"));
            } catch {
              return Effect.fail(failure("exec-status"));
            }
          }),
        );
      const runControl = (argv: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const created = yield* request({
            method: "POST",
            path: `/containers/${encodeURIComponent(container)}/exec`,
            body: {
              Cmd: [helperPath, ...argv],
              AttachStdout: true,
              AttachStderr: false,
              AttachStdin: false,
              Tty: false,
              ...(target.user === undefined ? {} : { User: target.user }),
            },
          });
          let id: string;
          try {
            const value = JSON.parse(created.body) as { Id?: unknown };
            if (typeof value.Id !== "string" || value.Id.length === 0)
              return yield* Effect.fail(failure("control-id"));
            id = value.Id;
          } catch {
            return yield* Effect.fail(failure("control-id"));
          }
          const decode = makeAttachDecoder();
          let output = "";
          yield* streamApi({
            method: "POST",
            path: `/exec/${encodeURIComponent(id)}/start`,
            body: { Detach: false, Tty: false },
          }).pipe(
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                for (const frame of decode(chunk)) {
                  if (frame.stream !== "stdout") continue;
                  if (output.length + frame.payload.length > 4096)
                    return yield* Effect.fail(failure("control-frame-limit"));
                  output += decoder.decode(frame.payload);
                }
              }),
            ),
          );
          const code = yield* inspectExit(id);
          try {
            const receipt = JSON.parse(output) as Receipt & { ok?: unknown };
            if (receipt.ok !== true) {
              const helperCode =
                "error" in receipt &&
                typeof receipt.error === "string" &&
                /^[a-z-]{1,64}$/.test(receipt.error)
                  ? receipt.error
                  : "invalid-error";
              return yield* Effect.fail(failure("control-rejected", { helperCode }));
            }
            if (
              code !== 0 ||
              !["initialized", "ready", "running", "finished", "cancelled", "collected"].includes(
                receipt.state,
              )
            )
              return yield* Effect.fail(failure("control-receipt"));
            if (
              receipt.exitCode !== undefined &&
              (!Number.isInteger(receipt.exitCode) || receipt.exitCode < 0 || receipt.exitCode > 255)
            )
              return yield* Effect.fail(failure("control-exit-status"));
            return receipt;
          } catch {
            return yield* Effect.fail(failure("control-receipt"));
          }
        }).pipe(
          Effect.timeout("2 seconds"),
          Effect.mapError((error) =>
            error instanceof ServiceExecError
              ? error
              : failure("control-unavailable", { category: error._tag }, error),
          ),
        );
      const control = (op: string, signal?: string) =>
        runControl(["exec-control", directory, nonce, op, ...(signal === undefined ? [] : [signal])]);
      const cleanupSession = yield* Effect.cached(runControl(["exec-cleanup", directory, nonce]));
      const poll = (
        id: string,
        operation: Effect.Effect<Receipt, ProviderError>,
        done: (receipt: Receipt) => boolean,
        attempts: number,
      ) =>
        Effect.gen(function* () {
          let observed: Receipt | undefined;
          let lastFailure: ProviderError | undefined;
          const result = yield* runProbe(
            {
              id,
              policy: {
                maxAttempts: attempts,
                delay: Duration.millis(100),
                ...(attempts === Number.MAX_SAFE_INTEGER ? {} : { timeout: Duration.seconds(6) }),
              },
              classify: {
                success: () => (observed !== undefined && done(observed) ? "green" : "yellow"),
                failure: () => (id === "supervisor-observation" ? "green" : "yellow"),
              },
            },
            operation.pipe(
              Effect.tap((receipt) =>
                Effect.sync(() => {
                  observed = receipt;
                  lastFailure = undefined;
                }),
              ),
              Effect.tapError((error) =>
                Effect.sync(() => {
                  lastFailure = error;
                }),
              ),
            ),
          );
          if (result.outcome !== "green" || observed === undefined || !done(observed))
            return yield* Effect.fail(lastFailure ?? failure(id));
          return observed;
        }).pipe(Effect.mapError((error) => failure(id, undefined, error)));
      let completed = false;
      let mainStarted = false;
      let mainExecId: string | undefined;
      let cancelling = false;
      const receipt = yield* Deferred.make<Receipt, ProviderError>();
      const output = yield* Queue.bounded<ExecChunk, ProviderError | Cause.Done>(16);
      // The release is registered before any potentially ambiguous supervisor start.
      const owned = yield* Effect.acquireRelease(
        Effect.succeed({
          attach: undefined as Fiber.Fiber<void, never> | undefined,
          monitor: undefined as Fiber.Fiber<void, never> | undefined,
          signalWatcher: undefined as Fiber.Fiber<void, never> | undefined,
        }),
        (owned) =>
          Effect.gen(function* () {
            cancelling = true;
            yield* Effect.sync(() => {
              owned.monitor?.interruptUnsafe();
              owned.signalWatcher?.interruptUnsafe();
            });
            const drain = yield* Stream.runDrain(Stream.fromQueue(output)).pipe(
              Effect.ignore,
              Effect.forkDetach,
            );
            const cleanup = Effect.gen(function* () {
              if (!completed) {
                // Cancellation persists a launch tombstone even when /start is delayed or ambiguous.
                yield* control("cancel", signalName(command.signal)).pipe(Effect.ignore);
                const final = yield* poll(
                  "cleanup-unconfirmed",
                  control("status"),
                  (state) =>
                    state.joined === true && (state.state === "finished" || state.state === "cancelled"),
                  50,
                );
                if (final.state === "finished" && final.exitCode === undefined)
                  return yield* Effect.fail(failure("cleanup-status-missing"));
                if (final.state === "finished") yield* Deferred.succeed(receipt, final);
                else yield* Deferred.fail(receipt, failure("cancelled-before-launch"));
                yield* control("collect");
              }
              if (owned.attach !== undefined) yield* Fiber.join(owned.attach);
              if (owned.monitor !== undefined) yield* Fiber.await(owned.monitor);
              if (owned.signalWatcher !== undefined) yield* Fiber.await(owned.signalWatcher);
              if (owned.attach === undefined) {
                yield* cleanupSession;
                return;
              }
              if (!mainStarted || mainExecId === undefined)
                return yield* Effect.fail(failure("primary-start-uncertain"));
              yield* inspectExit(mainExecId);
              yield* cleanupSession;
            }).pipe(
              Effect.interruptible,
              Effect.timeout("8 seconds"),
              Effect.mapError((error) => failure("cleanup-unconfirmed", undefined, error)),
            );
            const result = yield* Effect.exit(cleanup);
            yield* Effect.sync(() => {
              owned.attach?.interruptUnsafe();
              owned.monitor?.interruptUnsafe();
              owned.signalWatcher?.interruptUnsafe();
              drain.interruptUnsafe();
            });
            yield* Queue.shutdown(output);
            if (result._tag === "Failure")
              return yield* Effect.failCause(
                failureDefectCause(annotateFailureRole(result.cause, "cleanup")),
              );
          }),
      );
      const awaitSignal =
        command.signal === undefined
          ? Effect.never
          : Effect.callback<void>((resume) => {
              const signal = command.signal;
              if (signal === undefined) return;
              if (signal.aborted) {
                resume(Effect.void);
                return;
              }
              const onAbort = () => resume(Effect.void);
              signal.addEventListener("abort", onAbort, { once: true });
              return Effect.sync(() => signal.removeEventListener("abort", onAbort));
            });
      owned.signalWatcher = yield* awaitSignal.pipe(
        Effect.andThen(Queue.interrupt(output)),
        Effect.asVoid,
        Effect.forkDetach,
      );
      yield* runControl(["exec-init", directory, nonce, digest]);
      if (command.signal?.aborted) return yield* Effect.interrupt;
      const supervise = Effect.gen(function* () {
        const ready = yield* poll(
          "supervisor-not-ready",
          control("ready"),
          (state) => state.state === "ready" || state.state === "cancelled",
          50,
        );
        if (command.signal?.aborted || ready.state === "cancelled")
          return yield* Effect.fail(failure("cancelled-before-launch"));
        yield* control("launch");
        const finished = yield* poll(
          "supervisor-observation",
          control("status"),
          (state) => state.state === "finished" && state.joined === true,
          Number.MAX_SAFE_INTEGER,
        );
        if (finished.exitCode === undefined) return yield* Effect.fail(failure("root-status-missing"));
        yield* Deferred.succeed(receipt, finished);
        yield* control("collect");
      }).pipe(
        Effect.catch((error) =>
          Deferred.fail(receipt, error).pipe(Effect.andThen(Queue.fail(output, error)), Effect.asVoid),
        ),
      );
      const { signal: _signal, ...payloadCommand } = command;
      const supervisedCommand: CommandSpec = {
        ...payloadCommand,
        command: [helperPath, "exec-supervisor", directory, nonce, "--", ...command.command],
        raw: true,
        tty: false,
      };
      const attach = Effect.scoped(
        transportExecStream(plan, target, supervisedCommand, {
          api,
          ctx: options.ctx,
          raw: true,
          containerId: container,
          onExecCreated: (id) => {
            mainExecId = id;
          },
          onExecStarted: () => {
            mainStarted = true;
          },
        }).pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              if ("exitCode" in chunk) {
                const final = yield* Deferred.await(receipt);
                if (!mainStarted || final.exitCode !== chunk.exitCode || final.joined !== true)
                  return yield* Effect.fail(failure("terminal-status-mismatch"));
                if (mainExecId === undefined) return yield* Effect.fail(failure("primary-start-uncertain"));
                yield* inspectExit(mainExecId);
                completed = true;
                if (!cancelling) yield* cleanupSession;
              }
              if (!cancelling) yield* Queue.offer(output, chunk);
            }),
          ),
          Effect.andThen(Queue.end(output)),
          Effect.catch((error) => Queue.fail(output, error)),
          Effect.asVoid,
        ),
      );
      owned.attach = yield* attach.pipe(Effect.forkDetach);
      owned.monitor = yield* supervise.pipe(Effect.forkDetach);
      return Stream.fromQueue(output);
    }),
  );
