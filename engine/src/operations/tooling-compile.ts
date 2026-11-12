import { resolveServiceRef } from "@lando/landofile/tooling-input";
import {
  type NormalizedToolingStep,
  type NormalizedToolingTask,
  normalizeToolingTask,
} from "@lando/landofile/tooling-normalize";
import { planRedactionValues } from "@lando/redaction/plan-values";

import { ToolingCompileError, type ToolingExecError, type ToolingInputError } from "@lando/sdk/errors";
import type { AppPlan, HostTerminal, ToolingTaskShape } from "@lando/sdk/schema";
import {
  EnvironmentValueResolver,
  type ProviderError,
  type ProviderSelectionError,
  RuntimeProviderRegistry,
  ShellRunner,
  ToolingEngine,
  type ToolingEngineResult,
  type ToolingInvocation,
} from "@lando/sdk/services";
import { Effect, Option, type Scope } from "effect";
import { runtimeProviderService } from "../runtime/bootstrap-layer-support.ts";
import { validateHostShellSteps } from "../services/host-shell-validation.ts";
import { runHostToolingWith } from "../services/host-tooling-engine.ts";
import { withShellRedactionTokens } from "../services/shell-runner.ts";
import type { AdmittedToolingInput } from "./tooling-input-admission.ts";
import { withToolingOutput } from "./tooling-output.ts";

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

interface InvocationOptions {
  readonly args?: ReadonlyArray<string>;
  readonly user?: string;
  readonly cwd?: string;
  readonly env?: import("@lando/sdk/schema").Environment;
  readonly agentEnvAllowlist?: ReadonlyArray<string>;
  readonly tty?: boolean;
  readonly hostTerminal?: HostTerminal;
  readonly stdinStream?: ToolingInvocation["stdinStream"];
  readonly terminalResize?: ToolingInvocation["terminalResize"];
  readonly signal?: AbortSignal;
}

export const stepInvocation = (
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
    ...(options.tty === undefined ? {} : { tty: options.tty }),
    ...(options.hostTerminal === undefined ? {} : { hostTerminal: options.hostTerminal }),
    ...(options.stdinStream === undefined ? {} : { stdinStream: options.stdinStream }),
    ...(options.terminalResize === undefined ? {} : { terminalResize: options.terminalResize }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
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
  readonly redactionTokens: readonly string[];
}

export interface CompileToolingInput extends Omit<InvocationOptions, "args"> {
  readonly admitted: AdmittedToolingInput;
  /** Display name used in errors, e.g. `app:build`. */
  readonly name: string;
  /** Effective-tooling key used for normalization and bracket event names. */
  readonly lookupKey: string;
  readonly task: ToolingTaskShape;
  readonly source: ToolingSource;
}

/**
 * Turns a resolved, admitted task into one invocation per normalized step. Empty tasks,
 * bad argv, and invalid service references fail before task steps or brackets run.
 */
export const compileToolingInvocations = Effect.fnUntraced(function* (
  input: CompileToolingInput,
): Effect.fn.Return<CompiledTooling, ToolingCompileError | ToolingInputError> {
  const normalized = yield* Effect.fromResult(
    normalizeToolingTask(input.lookupKey, input.task, input.source),
  );
  const admitted = input.admitted;
  if (normalized.steps.length === 0) {
    return yield* Effect.fail(
      new ToolingCompileError({
        message: `Tooling command ${input.name} does not define cmd or cmds.`,
        tool: input.name,
      }),
    );
  }
  const { values, argv } = admitted;
  const invocations = yield* Effect.forEach(
    normalized.steps,
    (step, index): Effect.Effect<ToolingInvocation, ToolingInputError> =>
      Effect.gen(function* () {
        const service = yield* Effect.fromResult(resolveServiceRef(step.service, values, normalized));
        return stepInvocation(
          input.name,
          { ...step, ...(service === undefined ? {} : { resolvedService: service }) },
          {
            ...input,
            args: index === normalized.steps.length - 1 ? argv : [],
          },
        );
      }),
  );
  for (const invocation of invocations) {
    if (invocation.service === ":host") {
      yield* validateHostShellSteps(input.name, invocation.hostSteps ?? [], admitted.redactionTokens);
    }
  }
  return { normalized, invocations, redactionTokens: admitted.redactionTokens };
});

export type ToolingExecutionError =
  | ProviderSelectionError
  | ToolingCompileError
  | ToolingExecError
  | ProviderError;

export interface ExecuteToolingInput {
  readonly provider?: import("@lando/sdk/services").RuntimeProvider["Service"];
  readonly plan: AppPlan;
  readonly tool: string;
  readonly invocations: ReadonlyArray<ToolingInvocation>;
  /** Whether any normalized step targets a container, so the provider is selected once. */
  readonly requiresProvider: boolean;
  /** Explicit substring tokens (tooling inputs, caller overrides). Plan authorization is applied here. */
  readonly redactionTokens?: ReadonlyArray<string>;
}

/**
 * Runs compiled invocations in authored order, stopping at the first non-zero exit. A
 * non-zero exit is the task's result, not a failure, so the accumulated streams travel
 * with it. A task that never touches a container never initializes a provider.
 */
export const executeToolingInvocations = Effect.fnUntraced(function* (
  input: ExecuteToolingInput,
): Effect.fn.Return<
  ToolingEngineResult,
  ToolingExecutionError,
  ToolingEngine | RuntimeProviderRegistry | EnvironmentValueResolver | Scope.Scope
> {
  const session = yield* (yield* EnvironmentValueResolver).openSession();
  const provider =
    input.provider ??
    (input.requiresProvider
      ? yield* Effect.flatMap(RuntimeProviderRegistry, (registry) => registry.select(input.plan))
      : runtimeProviderService);
  let combined: ToolingEngineResult = {
    tool: input.tool,
    service: "",
    exitCode: 0,
    stdout: "",
    stderr: "",
  };
  for (const typedInvocation of input.invocations) {
    const invocation = {
      ...typedInvocation,
      ...(typedInvocation.env === undefined
        ? {}
        : { env: yield* session.resolveEnvironment(typedInvocation.env) }),
    };
    const run: Effect.Effect<
      ToolingEngineResult,
      ToolingExecutionError,
      EnvironmentValueResolver | ToolingEngine
    > =
      invocation.service === ":host"
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
            const planValues = planRedactionValues(input.plan);
            return yield* withShellRedactionTokens(
              {
                substring: input.redactionTokens ?? [],
                wholeToken: planValues.wholeTokenValues,
                publicValues: planValues.publicValues,
              },
              hostRun,
            );
          })
        : Effect.flatMap(ToolingEngine, (engine) => engine.run(invocation, input.plan, provider));
    const result = yield* withToolingOutput(run);
    combined = {
      ...result,
      stdout: combined.stdout + (result.stdout ?? ""),
      stderr: combined.stderr + (result.stderr ?? ""),
    };
    if (result.exitCode !== 0) break;
  }
  return combined;
}, Effect.scoped);
