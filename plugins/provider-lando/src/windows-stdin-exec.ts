import { Effect, Stream } from "effect";

import { ServiceExecError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import type { CommandSpec, ExecChunk, ExecResult, ExecTarget } from "@lando/sdk/services";
import type { ProcessRunner } from "@lando/sdk/services";
import type { Context } from "effect";

type Runner = Context.Tag.Service<typeof ProcessRunner>;

const containerName = (plan: AppPlan, target: ExecTarget): string =>
  `lando-${plan.slug}-${target.service}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

export const windowsStdinExecArgs = (
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
  connectionName: string,
): ReadonlyArray<string> => [
  "--connection",
  connectionName,
  "exec",
  "-i",
  ...(target.user === undefined ? [] : ["--user", target.user]),
  ...(command.cwd === undefined ? [] : ["--workdir", command.cwd]),
  ...Object.keys(command.env ?? {}).flatMap((name) => ["--env", name]),
  containerName(plan, target),
  ...command.command,
];

export const windowsStdinExec = (
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
  input: { readonly podmanBin: string; readonly connectionName: string; readonly processRunner: Runner },
): Effect.Effect<ExecResult, ServiceExecError> =>
  input.processRunner
    .run({
      cmd: input.podmanBin,
      args: windowsStdinExecArgs(plan, target, command, input.connectionName),
      ...(command.env === undefined ? {} : { env: command.env }),
      ...(command.signal === undefined ? {} : { signal: command.signal }),
      ...(command.stdinStream === undefined ? {} : { stdinStream: command.stdinStream }),
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ServiceExecError({
            providerId: "lando",
            operation: "exec",
            service: target.service,
            message: "Managed Windows Podman CLI could not execute the command.",
            details: { cause },
          }),
      ),
    );

export const windowsStdinExecStream = (
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
  input: { readonly podmanBin: string; readonly connectionName: string; readonly processRunner: Runner },
): Stream.Stream<ExecChunk, ServiceExecError> =>
  input.processRunner
    .streamWithExit({
      cmd: input.podmanBin,
      args: windowsStdinExecArgs(plan, target, command, input.connectionName),
      ...(command.env === undefined ? {} : { env: command.env }),
      ...(command.signal === undefined ? {} : { signal: command.signal }),
      ...(command.stdinStream === undefined ? {} : { stdinStream: command.stdinStream }),
    })
    .pipe(
      Stream.map((event): ExecChunk => event),
      Stream.mapError(
        (cause) =>
          new ServiceExecError({
            providerId: "lando",
            operation: "exec",
            service: target.service,
            message: "Managed Windows Podman CLI could not stream the command.",
            details: { cause },
          }),
      ),
    );
