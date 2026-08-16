import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Context, Effect, Layer } from "effect";

import { ShellExecError, ShellScriptOutsideRootError, ToolingExecError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import {
  type RuntimeProviderShape,
  type ShellCommandOptions,
  type ShellRunner,
  ToolingEngine,
  type ToolingEngineResult,
  type ToolingInvocation,
} from "@lando/sdk/services";

import { quoteShellPath } from "./shell-quote.ts";
import { makeShellRunnerService } from "./shell-runner.ts";
import { noCommandsError } from "./tooling-engine.ts";

const HOST_SERVICE = ":host";
const hostShellRunner = makeShellRunnerService(() => {
  throw new ShellExecError({ message: "Interactive host tooling is unavailable.", command: "" });
});

const wrapShellAsToolingError = (tool: string, shellError: ShellExecError): ToolingExecError =>
  new ToolingExecError({
    message: `Host tooling task ${tool} failed: ${shellError.message}`,
    tool,
    ...(shellError.exitCode === undefined ? {} : { exitCode: shellError.exitCode }),
    cause: shellError,
  });

const hostRun = (
  shell: Context.Tag.Service<typeof ShellRunner>,
  invocation: ToolingInvocation,
  _plan: AppPlan,
  _provider: RuntimeProviderShape,
) =>
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
      const commandLine = command.map(quoteShellPath).join(" ");
      const result = yield* shell.exec(commandLine, options).pipe(
        Effect.catchAll((cause) =>
          cause.exitCode !== undefined
            ? Effect.succeed({
                exitCode: cause.exitCode,
                stdout: cause.stdout ?? "",
                stderr: cause.stderr ?? "",
              })
            : Effect.fail(wrapShellAsToolingError(invocation.tool, cause)),
        ),
      );
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

export const runHostToolingWith = (
  shell: Context.Tag.Service<typeof ShellRunner>,
  invocation: ToolingInvocation,
  plan: AppPlan,
  provider: RuntimeProviderShape,
): Effect.Effect<ToolingEngineResult, ToolingExecError> => hostRun(shell, invocation, plan, provider);

const makeHostToolingEngine = (shell: Context.Tag.Service<typeof ShellRunner>) => ({
  id: "host",
  run: (invocation: ToolingInvocation, plan: AppPlan, provider: RuntimeProviderShape) =>
    hostRun(shell, invocation, plan, provider),
});

export const HostToolingEngineLive = Layer.succeed(ToolingEngine, makeHostToolingEngine(hostShellRunner));

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
      "Move the script inside the app root (or recipe cache for recipe-bundled scripts) and ensure no symlinks escape it.",
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

export const runHostScript = (
  scriptPath: string,
  permittedRoots: ReadonlyArray<string>,
  options?: ShellCommandOptions,
) =>
  Effect.gen(function* () {
    const resolved = yield* resolveScriptPath(scriptPath, permittedRoots);
    return yield* hostShellRunner.runScript(resolved, options);
  });

export const evaluateHostVar = (
  command: string,
  options?: ShellCommandOptions,
): Effect.Effect<string, ShellExecError> =>
  hostShellRunner.exec(command, options).pipe(Effect.map((result) => result.stdout.replace(/\r?\n$/u, "")));
