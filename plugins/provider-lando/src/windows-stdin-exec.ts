// The managed Windows stdin transport cannot yet carry the private supervisor
// control protocol. Reject before spawning so interruption cannot orphan a command.
import { serviceContainerName } from "@lando/container-runtime/plan";
import { Effect, Stream } from "effect";

import { ServiceExecError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import type { CommandSpec, ExecChunk, ExecResult, ExecTarget } from "@lando/sdk/services";
import type { ProcessRunner } from "@lando/sdk/services";
import type { Context } from "effect";

type Runner = Context.Service.Shape<typeof ProcessRunner>;

const containerName = (plan: AppPlan, target: ExecTarget): string =>
  serviceContainerName(plan, target.service);

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

const unsupportedWindowsStdin = (target: ExecTarget) =>
  new ServiceExecError({
    providerId: "lando",
    operation: "exec",
    service: target.service,
    message: "Managed Windows stdin execution cannot confirm container command cleanup.",
    remediation:
      "Run this command from WSL or a supported terminal until managed Windows stdin supports supervised execution.",
  });

export const windowsStdinExec = (
  _plan: AppPlan,
  target: ExecTarget,
  _command: CommandSpec,
  _input: { readonly podmanBin: string; readonly connectionName: string; readonly processRunner: Runner },
): Effect.Effect<ExecResult, ServiceExecError> => Effect.fail(unsupportedWindowsStdin(target));

export const windowsStdinExecStream = (
  _plan: AppPlan,
  target: ExecTarget,
  _command: CommandSpec,
  _input: { readonly podmanBin: string; readonly connectionName: string; readonly processRunner: Runner },
): Stream.Stream<ExecChunk, ServiceExecError> => Stream.fail(unsupportedWindowsStdin(target));
