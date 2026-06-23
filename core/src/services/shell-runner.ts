import { $ } from "bun";
import { type Context, Effect, Layer } from "effect";

import { ShellExecError } from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";
import { type ProcessResult, type ShellCommandOptions, ShellRunner } from "@lando/sdk/services";

import { RedactionService } from "../redaction/service.ts";
import { quoteShellPath } from "./shell-quote.ts";

const decoder = new TextDecoder();

interface ShellOutput {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

const shellError = (
  command: string,
  options: ShellCommandOptions | undefined,
  cause: unknown,
  output?: ProcessResult,
): ShellExecError =>
  new ShellExecError({
    message: cause instanceof Error ? cause.message : `Shell command failed: ${command}`,
    command,
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(output?.exitCode === undefined ? {} : { exitCode: output.exitCode }),
    ...(output?.stdout === undefined ? {} : { stdout: output.stdout }),
    ...(output?.stderr === undefined ? {} : { stderr: output.stderr }),
    cause,
  });

const toProcessResult = (output: ShellOutput): ProcessResult => ({
  exitCode: output.exitCode,
  stdout: decoder.decode(output.stdout),
  stderr: decoder.decode(output.stderr),
});

const isShellExecError = (cause: unknown): cause is ShellExecError =>
  typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === "ShellExecError";

const identityRedactor: Pick<Redactor, "redactString"> = { redactString: (text) => text };

const redactorForOptions = (options: ShellCommandOptions | undefined) =>
  Effect.gen(function* () {
    const redaction = yield* Effect.serviceOption(RedactionService);
    if (redaction._tag === "None") return identityRedactor;
    return yield* redaction.value.forProfile("secrets", {
      sourceEnv: { ...process.env, ...(options?.env ?? {}) },
    });
  });

const redactShellError = (options: ShellCommandOptions | undefined, error: ShellExecError) =>
  Effect.gen(function* () {
    const redactor = yield* redactorForOptions(options);
    return new ShellExecError({
      message: redactor.redactString(error.message),
      command: redactor.redactString(error.command),
      ...(error.cwd === undefined ? {} : { cwd: redactor.redactString(error.cwd) }),
      ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
      ...(error.stdout === undefined ? {} : { stdout: redactor.redactString(error.stdout) }),
      ...(error.stderr === undefined ? {} : { stderr: redactor.redactString(error.stderr) }),
      cause: error.cause,
    });
  });

const execShell = async (command: string, options?: ShellCommandOptions): Promise<ProcessResult> => {
  let shell = $`${{ raw: command }}`.quiet().nothrow();

  if (options?.cwd !== undefined) {
    shell = shell.cwd(options.cwd);
  }
  if (options?.env !== undefined) {
    shell = shell.env({ ...process.env, ...options.env });
  }

  const result = toProcessResult((await shell) as ShellOutput);
  if (result.exitCode !== 0) {
    throw shellError(
      command,
      options,
      new Error(`Shell command exited with code ${result.exitCode}`),
      result,
    );
  }

  return result;
};

const shellRunnerService: Context.Tag.Service<typeof ShellRunner> = {
  exec: (command, options) =>
    Effect.tryPromise({
      try: () => execShell(command, options),
      catch: (cause) => (isShellExecError(cause) ? cause : shellError(command, options, cause)),
    }).pipe(Effect.catchAll((error) => Effect.flatMap(redactShellError(options, error), Effect.fail))),
  run: (command, options) => shellRunnerService.exec(command, options),
  runScript: (path, options) => shellRunnerService.exec(`bun ${quoteShellPath(path)}`, options),
};

export const ShellRunnerLive = Layer.succeed(ShellRunner, shellRunnerService);
