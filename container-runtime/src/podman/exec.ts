import { ServiceExecError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import type { CommandSpec, ExecChunk, ExecResult, ExecTarget, ProviderError } from "@lando/sdk/services";
import { Effect, type Scope, Stream } from "effect";
import { missingApi, missingService } from "../engine-errors.ts";
import { type ExecSupervisionOptions, supervisedExecStream } from "../exec-supervision.ts";
import {
  type ExecOptions as TransportOptions,
  prepareExecCommand,
  execStream as transportExecStream,
} from "./exec-transport.ts";

export interface ExecOptions extends TransportOptions, ExecSupervisionOptions {}

const interrupted = (signal: AbortSignal | undefined): Effect.Effect<never> =>
  signal === undefined
    ? Effect.never
    : Effect.callback((resume) => {
        if (signal.aborted) {
          resume(Effect.interrupt);
          return;
        }
        const abort = () => resume(Effect.interrupt);
        signal.addEventListener("abort", abort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", abort));
      });

export const execStream = (
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
  options: ExecOptions,
): Stream.Stream<ExecChunk, ProviderError, Scope.Scope> =>
  Stream.suspend(() => {
    if (plan.services[target.service] === undefined)
      return Stream.fail(missingService(options.ctx, target, "exec"));
    if (options.api === undefined) return Stream.fail(missingApi(options.ctx, "exec"));
    if (command.tty === true) return transportExecStream(plan, target, command, options);
    return Stream.unwrap(
      Effect.raceFirst(prepareExecCommand(plan, target, command, options), interrupted(command.signal)).pipe(
        Effect.map((prepared) => supervisedExecStream(plan, target, prepared, options)),
      ),
    );
  }).pipe(Stream.withSpan("RuntimeProvider.execStream"));

export const exec = Effect.fn("RuntimeProvider.exec")(function* (
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
  options: ExecOptions,
): Effect.fn.Return<ExecResult, ProviderError, Scope.Scope> {
  const chunks = yield* Stream.runCollect(execStream(plan, target, command, options));
  const stdout = new TextDecoder();
  const stderr = new TextDecoder();
  let out = "";
  let err = "";
  let exitCode: number | undefined;
  for (const chunk of chunks) {
    if ("exitCode" in chunk) exitCode = chunk.exitCode;
    else if (chunk.kind === "stdout") out += stdout.decode(chunk.chunk, { stream: true });
    else err += stderr.decode(chunk.chunk, { stream: true });
  }
  out += stdout.decode();
  err += stderr.decode();
  if (exitCode === undefined)
    return yield* Effect.fail(
      new ServiceExecError({
        providerId: options.ctx.providerId,
        operation: "exec",
        service: target.service,
        message: "Container exec ended without an observed exit status.",
        remediation: "Check the service state and retry the command.",
      }),
    );
  return { exitCode, stdout: out, stderr: err };
}, Effect.scoped);
