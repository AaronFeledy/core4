import { parseToolingArgv, resolveServiceRef } from "@lando/landofile/tooling-input";
import {
  type NormalizedToolingStep,
  type NormalizedToolingTask,
  normalizeToolingTask,
} from "@lando/landofile/tooling-normalize";
import { Effect, Option } from "effect";

import {
  type NoProviderInstalledError,
  ToolingCompileError,
  ToolingDisabledError,
  type ToolingExecError,
  type ToolingInputError,
} from "@lando/sdk/errors";
import type { AppPlan, ToolingTaskShape } from "@lando/sdk/schema";
import {
  type ProviderError,
  RuntimeProviderRegistry,
  ShellRunner,
  ToolingEngine,
  type ToolingEngineResult,
  type ToolingInvocation,
} from "@lando/sdk/services";

import { runtimeProviderService } from "../runtime/bootstrap-layer-support.ts";
import { runHostToolingWith } from "../services/host-tooling-engine.ts";
import { withShellRedactionTokens } from "../services/shell-runner.ts";

const POSITIONAL_PARAMETER = /\$(?:@|[1-9]|\{(?:@|[1-9]))/u;

const shellCommand = (command: string, args: ReadonlyArray<string>): ReadonlyArray<string> => [
  "sh",
  "-c",
  POSITIONAL_PARAMETER.test(command) ? command : `${command} "$@"`,
  "lando-tooling",
  ...args,
];

export interface ToolingSource {
  readonly path: string;
  readonly task: string;
}

export const validateToolingArguments = (
  name: string,
  task: { readonly acceptsArguments: boolean },
  args: ReadonlyArray<string>,
): ToolingCompileError | undefined =>
  !task.acceptsArguments && args.length > 0
    ? new ToolingCompileError({
        message: `Tooling command ${name} does not accept positional arguments.`,
        tool: name,
        remediation: `Run \`lando ${name}\` without arguments.`,
      })
    : undefined;

interface InvocationOptions {
  readonly args?: ReadonlyArray<string>;
  readonly user?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly agentEnvAllowlist?: ReadonlyArray<string>;
}

const stepInvocation = (
  tool: string,
  step: NormalizedToolingStep & { readonly resolvedService?: string },
  options: InvocationOptions,
): ToolingInvocation => {
  const args = options.args ?? [];
  const cwd = step.dir ?? options.cwd;
  const user = options.user ?? step.user;
  return {
    tool,
    ...(step.resolvedService === undefined ? {} : { service: step.resolvedService }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(user === undefined ? {} : { user }),
    ...(Object.keys(step.env).length === 0 && options.env === undefined
      ? {}
      : { env: { ...step.env, ...options.env } }),
    ...(options.agentEnvAllowlist === undefined ? {} : { agentEnvAllowlist: options.agentEnvAllowlist }),
    commands: [step.argv === undefined ? shellCommand(step.cmd, args) : [...step.argv, ...args]],
    hostSteps: [
      step.argv === undefined
        ? { kind: "shell", source: step.cmd, argv: args }
        : { kind: "argv", argv: [...step.argv, ...args] },
    ],
  };
};

export interface CompiledTooling {
  readonly normalized: NormalizedToolingTask;
  readonly invocations: ReadonlyArray<ToolingInvocation>;
}

export interface CompileToolingInput extends InvocationOptions {
  /** Display name used in errors, e.g. `app:build`. */
  readonly name: string;
  /** Effective-tooling key used for normalization and bracket event names. */
  readonly lookupKey: string;
  readonly task: ToolingTaskShape;
  readonly source: ToolingSource;
}

/**
 * Turns an authored task into one invocation per normalized step. Every deterministic
 * rejection (disabled, empty, bad argv, unknown service reference) happens here, before
 * any provider is selected or any event bracket runs.
 */
export const compileToolingInvocations = (
  input: CompileToolingInput,
): Effect.Effect<CompiledTooling, ToolingCompileError | ToolingDisabledError | ToolingInputError> =>
  Effect.gen(function* () {
    const normalized = yield* normalizeToolingTask(input.lookupKey, input.task, input.source);
    if (normalized.disabled) {
      return yield* Effect.fail(
        new ToolingDisabledError({
          message: `Tooling command ${input.name} is disabled.`,
          tool: input.lookupKey,
          source: input.source,
          remediation: `Enable tooling task ${input.lookupKey} in ${input.source.path} before running it.`,
        }),
      );
    }
    if (normalized.steps.length === 0) {
      return yield* Effect.fail(
        new ToolingCompileError({
          message: `Tooling command ${input.name} does not define cmd or cmds.`,
          tool: input.name,
        }),
      );
    }
    if (!normalized.hasInput) {
      const argumentFailure = validateToolingArguments(input.name, normalized, input.args ?? []);
      if (argumentFailure !== undefined) return yield* Effect.fail(argumentFailure);
    }
    const values = yield* parseToolingArgv(normalized, input.args ?? []);
    const invocations = yield* Effect.forEach(
      normalized.steps,
      (step, index): Effect.Effect<ToolingInvocation, ToolingInputError> =>
        Effect.gen(function* () {
          const service = yield* resolveServiceRef(step.service, values, normalized);
          return stepInvocation(
            input.name,
            { ...step, ...(service === undefined ? {} : { resolvedService: service }) },
            {
              ...input,
              args: index === normalized.steps.length - 1 ? values.argv : [],
            },
          );
        }),
    );
    return { normalized, invocations };
  });

export type ToolingExecutionError =
  | ToolingCompileError
  | NoProviderInstalledError
  | ToolingExecError
  | ProviderError;

export interface ExecuteToolingInput {
  readonly plan: AppPlan;
  readonly tool: string;
  readonly invocations: ReadonlyArray<ToolingInvocation>;
  /** Whether any normalized step targets a container, so the provider is selected once. */
  readonly requiresProvider: boolean;
  readonly redactionTokens?: ReadonlyArray<string>;
}

/**
 * Runs compiled invocations in authored order, stopping at the first non-zero exit. A
 * non-zero exit is the task's result, not a failure, so the accumulated streams travel
 * with it. A task that never touches a container never initializes a provider.
 */
export const executeToolingInvocations = (
  input: ExecuteToolingInput,
): Effect.Effect<ToolingEngineResult, ToolingExecutionError, ToolingEngine | RuntimeProviderRegistry> =>
  Effect.gen(function* () {
    const provider = input.requiresProvider
      ? yield* Effect.flatMap(RuntimeProviderRegistry, (registry) => registry.select(input.plan))
      : runtimeProviderService;
    let combined: ToolingEngineResult = {
      tool: input.tool,
      service: "",
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
    for (const invocation of input.invocations) {
      const result = yield* invocation.service === ":host"
        ? Effect.gen(function* () {
            const shell = yield* Effect.serviceOption(ShellRunner);
            if (Option.isNone(shell)) {
              return yield* Effect.fail(
                new ToolingCompileError({
                  message: `ShellRunner is unavailable for tooling command ${input.tool}.`,
                  tool: input.tool,
                }),
              );
            }
            const hostRun = runHostToolingWith(shell.value, invocation, input.plan, provider);
            return yield* input.redactionTokens === undefined
              ? hostRun
              : withShellRedactionTokens(input.redactionTokens, hostRun);
          })
        : Effect.flatMap(ToolingEngine, (engine) => engine.run(invocation, input.plan, provider));
      combined = {
        ...result,
        stdout: combined.stdout + result.stdout,
        stderr: combined.stderr + result.stderr,
      };
      if (result.exitCode !== 0) break;
    }
    return combined;
  });
