import { Effect } from "effect";

import type {
  CapabilityError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import { ToolingCompileError, type ToolingExecError } from "@lando/sdk/errors";
import type { ToolingTaskShape } from "@lando/sdk/schema";
import {
  AppPlanner,
  LandofileService,
  type ProviderError,
  RuntimeProviderRegistry,
  ToolingEngine,
  type ToolingInvocation,
} from "@lando/sdk/services";

export interface RunToolingOptions {
  readonly name: string;
  readonly args?: ReadonlyArray<string>;
  readonly user?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface RunToolingResult {
  readonly tool: string;
  readonly service: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

type RunToolingError =
  | CapabilityError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileValidationError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | ToolingCompileError
  | ToolingExecError;

type RunToolingServices = AppPlanner | LandofileService | RuntimeProviderRegistry | ToolingEngine;

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const joinShell = (parts: ReadonlyArray<string>): string => parts.filter(isNonEmptyString).join(" ");

const normalizeCommands = (
  task: ToolingTaskShape,
  args: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const cmds = task.cmds;
  if (cmds !== undefined && cmds.length > 0) {
    return cmds.map((cmd, index) => {
      const lastIndex = cmds.length - 1;
      const tail = index === lastIndex && args.length > 0 ? ` ${joinShell(args)}` : "";
      return ["sh", "-c", `${cmd}${tail}`];
    });
  }
  if (task.cmd !== undefined) {
    if (typeof task.cmd === "string") {
      const tail = args.length > 0 ? ` ${joinShell(args)}` : "";
      return [["sh", "-c", `${task.cmd}${tail}`]];
    }
    return [[...task.cmd, ...args]];
  }
  return [];
};

export const buildToolingInvocation = (
  name: string,
  task: ToolingTaskShape,
  options: Pick<RunToolingOptions, "args" | "user" | "cwd" | "env"> = {},
): ToolingInvocation => {
  const commands = normalizeCommands(task, options.args ?? []);
  return {
    tool: name,
    ...(task.service === undefined ? {} : { service: task.service }),
    ...(options.user === undefined ? {} : { user: options.user }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    commands,
  };
};

export const renderRunToolingResult = (result: RunToolingResult): string | undefined =>
  result.stdout.length === 0 ? undefined : result.stdout;

export const runTooling = (
  options: RunToolingOptions,
): Effect.Effect<RunToolingResult, RunToolingError, RunToolingServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const planner = yield* AppPlanner;
    const registry = yield* RuntimeProviderRegistry;
    const engine = yield* ToolingEngine;

    const landofile = yield* landofileService.discover;
    const task = landofile.tooling?.[options.name];
    if (task === undefined) {
      return yield* Effect.fail(
        new ToolingCompileError({
          message: `Unknown tooling command: ${options.name}.`,
          tool: options.name,
        }),
      );
    }

    if (task.cmd === undefined && (task.cmds === undefined || task.cmds.length === 0)) {
      return yield* Effect.fail(
        new ToolingCompileError({
          message: `Tooling command ${options.name} does not define cmd or cmds.`,
          tool: options.name,
        }),
      );
    }

    const capabilities = yield* registry.capabilities;
    const plan = yield* planner.plan(landofile, capabilities);
    const provider = yield* registry.select(plan);

    const invocation = buildToolingInvocation(options.name, task, {
      ...(options.args === undefined ? {} : { args: options.args }),
      ...(options.user === undefined ? {} : { user: options.user }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });

    const result = yield* engine.run(invocation, plan, provider);

    if (result.stderr.length > 0) {
      yield* Effect.sync(() => {
        process.stderr.write(result.stderr);
      });
    }

    return {
      tool: result.tool,
      service: String(result.service),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
