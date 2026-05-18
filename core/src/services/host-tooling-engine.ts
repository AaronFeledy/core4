import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { Effect, Layer } from "effect";

import { ShellExecError, ShellScriptOutsideRootError, ToolingExecError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import {
  type ProcessResult,
  type RuntimeProviderShape,
  type ShellCommandOptions,
  ToolingEngine,
  type ToolingEngineResult,
  type ToolingInvocation,
} from "@lando/sdk/services";

const HOST_SERVICE = ":host";
const decoder = new TextDecoder();

interface BunShellOutput {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

const toProcessResult = (output: BunShellOutput): ProcessResult => ({
  exitCode: output.exitCode,
  stdout: decoder.decode(output.stdout),
  stderr: decoder.decode(output.stderr),
});

const formatArgvForMessage = (command: ReadonlyArray<string>): string =>
  command.length === 0 ? "" : command.join(" ");

const buildBunShell = (command: ReadonlyArray<string>, options: ShellCommandOptions | undefined) => {
  let shell: ReturnType<typeof $>;
  if (command.length >= 3 && command[0] === "sh" && command[1] === "-c") {
    shell = $`${{ raw: command[2] ?? "" }}`;
  } else {
    shell = $`${command}`;
  }
  shell = shell.quiet().nothrow();
  if (options?.cwd !== undefined) shell = shell.cwd(options.cwd);
  if (options?.env !== undefined) {
    shell = shell.env({ ...process.env, ...options.env });
  }
  return shell;
};

const execHost = async (
  command: ReadonlyArray<string>,
  options?: ShellCommandOptions,
): Promise<ProcessResult> => {
  const output = (await buildBunShell(command, options)) as BunShellOutput;
  return toProcessResult(output);
};

const shellLaunchError = (
  command: ReadonlyArray<string>,
  options: ShellCommandOptions | undefined,
  cause: unknown,
): ShellExecError =>
  new ShellExecError({
    message:
      cause instanceof Error
        ? cause.message
        : `Host shell failed to launch: ${formatArgvForMessage(command)}`,
    command: formatArgvForMessage(command),
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    cause,
  });

const wrapShellAsToolingError = (tool: string, shellError: ShellExecError): ToolingExecError =>
  new ToolingExecError({
    message: `Host tooling task ${tool} failed: ${shellError.message}`,
    tool,
    ...(shellError.exitCode === undefined ? {} : { exitCode: shellError.exitCode }),
    cause: shellError,
  });

const noCommandsError = (tool: string): ToolingExecError =>
  new ToolingExecError({
    message: `Tooling task ${tool} has no commands to run.`,
    tool,
  });

const hostRun = (invocation: ToolingInvocation, _plan: AppPlan, _provider: RuntimeProviderShape) =>
  Effect.gen(function* () {
    if (invocation.commands.length === 0) {
      return yield* Effect.fail(noCommandsError(invocation.tool));
    }
    let exitCode = 0;
    let stdout = "";
    let stderr = "";
    for (const command of invocation.commands) {
      const options: ShellCommandOptions = {
        ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
        ...(invocation.env === undefined ? {} : { env: invocation.env }),
      };
      const result = yield* Effect.tryPromise({
        try: () => execHost(command, options),
        catch: (cause) => wrapShellAsToolingError(invocation.tool, shellLaunchError(command, options, cause)),
      });
      stdout += result.stdout;
      stderr += result.stderr;
      exitCode = result.exitCode;
      if (exitCode !== 0) break;
    }
    const out: ToolingEngineResult = {
      tool: invocation.tool,
      service: invocation.service ?? HOST_SERVICE,
      exitCode,
      stdout,
      stderr,
    };
    return out;
  });

export const HostToolingEngineLive = Layer.succeed(ToolingEngine, {
  id: "host",
  run: hostRun,
});

const normalizeRoot = async (root: string): Promise<string> => {
  const resolved = await fs.realpath(root);
  return path.resolve(resolved);
};

const isWithinRoot = (target: string, root: string): boolean => {
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target.startsWith(prefix);
};

const outsideRootError = (
  scriptPath: string,
  permittedRoots: ReadonlyArray<string>,
  realpathValue?: string,
  cause?: unknown,
) =>
  new ShellScriptOutsideRootError({
    message: `Host shell script ${scriptPath} resolves outside the permitted base directories.`,
    path: scriptPath,
    ...(realpathValue === undefined ? {} : { realpath: realpathValue }),
    permittedRoots,
    remediation:
      "Move the script inside the app root (or recipe cache for recipe-bundled scripts) and ensure no symlinks escape it; see spec §8.5.9.",
    ...(cause === undefined ? {} : { cause }),
  });

export const resolveScriptPath = (
  scriptPath: string,
  permittedRoots: ReadonlyArray<string>,
): Effect.Effect<string, ShellScriptOutsideRootError> =>
  Effect.tryPromise({
    try: async () => {
      if (permittedRoots.length === 0) {
        throw outsideRootError(scriptPath, permittedRoots);
      }
      let resolvedScript: string;
      try {
        resolvedScript = path.resolve(await fs.realpath(scriptPath));
      } catch (cause) {
        throw outsideRootError(scriptPath, permittedRoots, undefined, cause);
      }
      const normalizedRoots: string[] = [];
      for (const root of permittedRoots) {
        try {
          normalizedRoots.push(await normalizeRoot(root));
        } catch {
          // Skip roots that cannot be resolved (e.g. missing recipe cache dir).
        }
      }
      const contained = normalizedRoots.some((root) => isWithinRoot(resolvedScript, root));
      if (!contained) {
        throw outsideRootError(scriptPath, permittedRoots, resolvedScript);
      }
      return resolvedScript;
    },
    catch: (cause) =>
      cause instanceof ShellScriptOutsideRootError
        ? cause
        : outsideRootError(scriptPath, permittedRoots, undefined, cause),
  });

const quoteShellPath = (target: string): string => `'${target.replaceAll("'", `'\\''`)}'`;

export const runHostScript = (
  scriptPath: string,
  permittedRoots: ReadonlyArray<string>,
  options?: ShellCommandOptions,
): Effect.Effect<ProcessResult, ShellExecError | ShellScriptOutsideRootError> =>
  Effect.gen(function* () {
    const resolved = yield* resolveScriptPath(scriptPath, permittedRoots);
    const command = `bun ${quoteShellPath(resolved)}`;
    return yield* Effect.tryPromise({
      try: async () => {
        let shell = $`${{ raw: command }}`.quiet().nothrow();
        if (options?.cwd !== undefined) shell = shell.cwd(options.cwd);
        if (options?.env !== undefined) shell = shell.env({ ...process.env, ...options.env });
        const out = (await shell) as BunShellOutput;
        const result = toProcessResult(out);
        if (result.exitCode !== 0) {
          throw new ShellExecError({
            message: `Host script ${scriptPath} exited with code ${result.exitCode}.`,
            command,
            ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          });
        }
        return result;
      },
      catch: (cause) =>
        cause instanceof ShellExecError
          ? cause
          : new ShellExecError({
              message: cause instanceof Error ? cause.message : `Host script ${scriptPath} failed to launch.`,
              command,
              ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
              cause,
            }),
    });
  });

export const evaluateHostVar = (
  command: string,
  options?: ShellCommandOptions,
): Effect.Effect<string, ShellExecError> =>
  Effect.tryPromise({
    try: async () => {
      let shell = $`${{ raw: command }}`.quiet().nothrow();
      if (options?.cwd !== undefined) shell = shell.cwd(options.cwd);
      if (options?.env !== undefined) shell = shell.env({ ...process.env, ...options.env });
      const out = (await shell) as BunShellOutput;
      const result = toProcessResult(out);
      if (result.exitCode !== 0) {
        throw new ShellExecError({
          message: `Host var.sh expression exited with code ${result.exitCode}.`,
          command,
          ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }
      return result.stdout.replace(/\r?\n$/u, "");
    },
    catch: (cause) =>
      cause instanceof ShellExecError
        ? cause
        : new ShellExecError({
            message: cause instanceof Error ? cause.message : `Host var.sh expression failed: ${command}`,
            command,
            ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
            cause,
          }),
  });
