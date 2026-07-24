import { Effect } from "effect";

import type { ToolingError, ToolingResult } from "@lando/sdk/app";
import { ToolingCompileError } from "@lando/sdk/errors";
import type { LandofileShape, ToolingTaskShape } from "@lando/sdk/schema";

import {
  AppPlanner,
  type ConfigService,
  EventService,
  LandofileService,
  RuntimeProviderRegistry,
  ToolingEngine,
  type ToolingInvocation,
} from "@lando/sdk/services";

import { resolveAgentEnvForwardAllowlist } from "../../config/agent-env-policy.ts";
import { type ResolvedAppTarget, loadUserLandofile, loadUserLandofileAt } from "../app-resolution.ts";
import { commandAliasConflictError, reservedTopLevelAliasOwner } from "../reserved-aliases.ts";

import { discoverBunShellScripts } from "../../landofile/bun-sh-discovery.ts";
import { findAppRoot } from "../../landofile/discovery.ts";

import { findBunShellScriptForName, runBunShellScript } from "./tooling-bun-script.ts";
import { emitToolingOutputProgress } from "./tooling-progress.ts";

export interface RunToolingOptions {
  readonly name: string;
  readonly args?: ReadonlyArray<string>;
  readonly user?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly cacheRoot?: string;
  readonly renderProgress?: boolean;
}

export type RunToolingResult = ToolingResult;
export type { ToolingResult };

type RunToolingError = ToolingError;

type RunToolingServices =
  | AppPlanner
  | ConfigService
  | EventService
  | LandofileService
  | RuntimeProviderRegistry
  | ToolingEngine;

const shellCommand = (command: string, args: ReadonlyArray<string>): ReadonlyArray<string> => [
  "sh",
  "-c",
  `${command} "$@"`,
  "lando-tooling",
  ...args,
];

const normalizeCommands = (
  task: ToolingTaskShape,
  args: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const cmds = task.cmds;
  if (cmds !== undefined && cmds.length > 0) {
    return cmds.map((cmd, index) => {
      const commandArgs = index === cmds.length - 1 ? args : [];
      return shellCommand(cmd, commandArgs);
    });
  }
  if (task.cmd !== undefined) {
    if (typeof task.cmd === "string") {
      return [shellCommand(task.cmd, args)];
    }
    return [[...task.cmd, ...args]];
  }
  return [];
};

export const buildToolingInvocation = (
  name: string,
  task: ToolingTaskShape,
  options: Pick<RunToolingOptions, "args" | "user" | "cwd" | "env"> & {
    readonly agentEnvAllowlist?: ReadonlyArray<string>;
  } = {},
): ToolingInvocation => {
  const commands = normalizeCommands(task, options.args ?? []);
  return {
    tool: name,
    ...(task.service === undefined ? {} : { service: task.service }),
    ...(options.user === undefined ? {} : { user: options.user }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.agentEnvAllowlist === undefined ? {} : { agentEnvAllowlist: options.agentEnvAllowlist }),
    commands,
  };
};

export const renderRunToolingResult = (result: RunToolingResult): string | undefined =>
  result.rendered === true || result.stdout.length === 0 ? undefined : result.stdout;

const withProcessCwd = <A, E, R>(
  cwd: string,
  use: () => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ToolingCompileError, R> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const original = process.cwd();
        process.chdir(cwd);
        return original;
      },
      catch: (cause) =>
        new ToolingCompileError({
          message: `Unable to enter the app directory at ${cwd}.`,
          tool: "tooling",
          cause,
        }),
    }),
    () => use(),
    (original) => Effect.sync(() => process.chdir(original)),
  );

const resolveToolingPlan = (input: {
  readonly landofile: LandofileShape;
  readonly appRoot: string | undefined;
}) =>
  Effect.gen(function* () {
    const planner = yield* AppPlanner;
    const registry = yield* RuntimeProviderRegistry;
    const capabilities = yield* registry.capabilities;
    return yield* input.appRoot === undefined
      ? planner.plan(input.landofile, capabilities)
      : withProcessCwd(input.appRoot, () => planner.plan(input.landofile, capabilities));
  });

export const runTooling = (
  options: RunToolingOptions,
  target?: ResolvedAppTarget,
): Effect.Effect<RunToolingResult, RunToolingError, RunToolingServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;

    const landofile =
      target === undefined
        ? yield* loadUserLandofile(landofileService)
        : yield* loadUserLandofileAt(landofileService, target.root);
    const toolingLookupKey = options.name.startsWith("app:") ? options.name.slice(4) : options.name;
    const task = landofile.tooling?.[toolingLookupKey];
    const reservedOwner = reservedTopLevelAliasOwner(toolingLookupKey);

    if (task !== undefined && reservedOwner !== undefined) {
      return yield* Effect.fail(
        commandAliasConflictError(toolingLookupKey, `tooling task ${toolingLookupKey}`),
      );
    }

    if (task === undefined) {
      const appRoot = yield* Effect.promise(() => findAppRoot(options.cwd ?? target?.root ?? process.cwd()));
      if (appRoot !== undefined) {
        const scripts = yield* discoverBunShellScripts({ appRoot });
        const script = findBunShellScriptForName(scripts, options.name);
        if (script !== undefined && reservedOwner !== undefined) {
          return yield* Effect.fail(
            commandAliasConflictError(toolingLookupKey, `script-backed tooling task ${script.id}`),
          );
        }
        if (script !== undefined) {
          const events =
            options.renderProgress === true ? yield* Effect.serviceOption(EventService) : undefined;
          const progressEvents = events?._tag === "Some" ? events.value : undefined;
          const startedAt = Date.now();
          const result = yield* runBunShellScript(script, appRoot, options);
          yield* emitToolingOutputProgress({
            events: progressEvents,
            tool: result.tool,
            service: result.service,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: Date.now() - startedAt,
          });
          return {
            ...result,
            ...(progressEvents === undefined ? {} : { rendered: true }),
          };
        }
      }
      return yield* Effect.fail(
        new ToolingCompileError({
          message: `Unknown tooling command: ${options.name}.`,
          tool: options.name,
          remediation:
            "Verify the tooling task name, then run `lando app cache refresh` after changing tooling configuration.",
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

    const appRoot = yield* Effect.promise(() => findAppRoot(options.cwd ?? target?.root ?? process.cwd()));
    const plan = target?.plan ?? (yield* resolveToolingPlan({ landofile, appRoot }));
    const registry = yield* RuntimeProviderRegistry;
    const engine = yield* ToolingEngine;
    const events = options.renderProgress === true ? yield* Effect.serviceOption(EventService) : undefined;
    const provider = yield* registry.select(plan);

    const agentEnvAllowlist = yield* resolveAgentEnvForwardAllowlist(landofile.agentEnv, process.env);
    const invocation = buildToolingInvocation(options.name, task, {
      ...(options.args === undefined ? {} : { args: options.args }),
      ...(options.user === undefined ? {} : { user: options.user }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      agentEnvAllowlist,
    });

    const startedAt = Date.now();
    const result = yield* engine.run(invocation, plan, provider);
    const progressEvents = events?._tag === "Some" ? events.value : undefined;

    yield* emitToolingOutputProgress({
      events: progressEvents,
      tool: result.tool,
      service: String(result.service),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startedAt,
    });

    return {
      tool: result.tool,
      service: String(result.service),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(progressEvents === undefined ? {} : { rendered: true }),
    };
  });
