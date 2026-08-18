import { Effect } from "effect";

import type { ToolingError, ToolingResult } from "@lando/sdk/app";
import {
  type ComposeKeyRejectedError,
  type LandofileLoadExpressionError,
  ToolingCompileError,
} from "@lando/sdk/errors";
import type { LandofileShape, ToolingTaskShape } from "@lando/sdk/schema";

import { RedactionService, collectSecretEnvValues, createStandaloneRedactor } from "@lando/redaction/service";
import {
  AppPlanner,
  type ConfigService,
  EventService,
  LandofileService,
  RuntimeProviderRegistry,
  ToolingEngine,
  type ToolingHostStep,
  type ToolingInvocation,
} from "@lando/sdk/services";

import { resolveAgentEnvForwardAllowlist } from "../config/agent-env-policy.ts";
import {
  type ResolvedAppTarget,
  loadUserLandofile,
  loadUserLandofileAt,
} from "../landofile/app-resolution.ts";
import { compileEffectiveTooling, effectiveToolingForPlan } from "../planner/effective-tooling.ts";
import { collectAppPlanRedactionTokens } from "../services/app-plan-redaction.ts";
import { commandAliasConflictError, reservedTopLevelAliasOwner } from "./reserved-aliases.ts";

import { findAppRoot } from "@lando/landofile/discovery";

import { runBunShellTooling } from "./tooling-bun-script.ts";
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

export type RunToolingResult = ToolingResult & {
  readonly redactionTokens?: ReadonlyArray<string>;
};
export type { ToolingResult };

export const runToolingRedactionTokens = (result: RunToolingResult): ReadonlyArray<string> =>
  result.redactionTokens ?? [];

type RunToolingError = ToolingError | ComposeKeyRejectedError | LandofileLoadExpressionError;

type RunToolingServices =
  | AppPlanner
  | ConfigService
  | LandofileService
  | RuntimeProviderRegistry
  | ToolingEngine;

const POSITIONAL_PARAMETER = /\$(?:@|[1-9]|\{(?:@|[1-9]))/u;

const shellCommand = (command: string, args: ReadonlyArray<string>): ReadonlyArray<string> => [
  "sh",
  "-c",
  POSITIONAL_PARAMETER.test(command) ? command : `${command} "$@"`,
  "lando-tooling",
  ...args,
];

export const validateToolingArguments = (
  name: string,
  task: ToolingTaskShape,
  args: ReadonlyArray<string>,
): ToolingCompileError | undefined =>
  task.arguments === false && args.length > 0
    ? new ToolingCompileError({
        message: `Tooling command ${name} does not accept positional arguments.`,
        tool: name,
        remediation: `Run \`lando ${name}\` without arguments.`,
      })
    : undefined;

const normalizeCommands = (
  task: ToolingTaskShape,
  args: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const forwardedArgs = task.arguments === false ? [] : args;
  const cmds = task.cmds;
  if (cmds !== undefined && cmds.length > 0) {
    return cmds.map((cmd, index) => {
      const commandArgs = index === cmds.length - 1 ? forwardedArgs : [];
      return shellCommand(cmd, commandArgs);
    });
  }
  if (task.cmd !== undefined) {
    if (typeof task.cmd === "string") {
      return [shellCommand(task.cmd, forwardedArgs)];
    }
    return [[...task.cmd, ...forwardedArgs]];
  }
  return [];
};

const normalizeHostSteps = (
  task: ToolingTaskShape,
  args: ReadonlyArray<string>,
): ReadonlyArray<ToolingHostStep> => {
  const forwardedArgs = task.arguments === false ? [] : args;
  const cmds = task.cmds;
  if (cmds !== undefined && cmds.length > 0) {
    return cmds.map((source, index) => ({
      kind: "shell",
      source,
      argv: index === cmds.length - 1 ? forwardedArgs : [],
    }));
  }
  if (task.cmd === undefined) return [];
  return typeof task.cmd === "string"
    ? [{ kind: "shell", source: task.cmd, argv: forwardedArgs }]
    : [{ kind: "argv", argv: [...task.cmd, ...forwardedArgs] }];
};

export const buildToolingInvocation = (
  name: string,
  task: ToolingTaskShape,
  options: Pick<RunToolingOptions, "args" | "user" | "cwd" | "env"> & {
    readonly agentEnvAllowlist?: ReadonlyArray<string>;
  } = {},
): ToolingInvocation => {
  const commands = normalizeCommands(task, options.args ?? []);
  const cwd = task.dir ?? options.cwd;
  const taskEnv =
    task.env === undefined
      ? undefined
      : Object.fromEntries(Object.entries(task.env).map(([key, value]) => [key, String(value)]));
  const env = taskEnv === undefined && options.env === undefined ? undefined : { ...taskEnv, ...options.env };
  return {
    tool: name,
    ...(task.service === undefined ? {} : { service: task.service }),
    ...(options.user === undefined ? {} : { user: options.user }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
    ...(options.agentEnvAllowlist === undefined ? {} : { agentEnvAllowlist: options.agentEnvAllowlist }),
    commands,
    hostSteps: normalizeHostSteps(task, options.args ?? []),
  };
};

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
    const appRoot = yield* Effect.promise(() => findAppRoot(options.cwd ?? target?.root ?? process.cwd()));
    const toolingLookupKey = options.name.startsWith("app:") ? options.name.slice(4) : options.name;
    const authoredTooling = compileEffectiveTooling({ landofile, services: [] });
    const servicesCanContributeTooling = Object.keys(landofile.services ?? {}).length > 0;

    if (
      target === undefined &&
      !servicesCanContributeTooling &&
      authoredTooling[toolingLookupKey] === undefined &&
      appRoot !== undefined
    ) {
      const scriptResult = yield* runBunShellTooling(options, appRoot);
      if (scriptResult !== undefined) return scriptResult;
    }

    const planResult =
      target === undefined
        ? yield* Effect.either(resolveToolingPlan({ landofile, appRoot }))
        : ({ _tag: "Right", right: target.plan } as const);
    if (planResult._tag === "Left") {
      if (appRoot !== undefined) {
        const scriptResult = yield* runBunShellTooling(options, appRoot);
        if (scriptResult !== undefined) return scriptResult;
      }
      return yield* Effect.fail(planResult.left);
    }
    const plan = planResult.right;
    const tooling = effectiveToolingForPlan(plan) ?? authoredTooling;
    const task = tooling[toolingLookupKey];
    const reservedOwner = reservedTopLevelAliasOwner(toolingLookupKey);

    if (task !== undefined && reservedOwner !== undefined) {
      return yield* Effect.fail(
        commandAliasConflictError(toolingLookupKey, `tooling task ${toolingLookupKey}`),
      );
    }

    if (task === undefined) {
      if (appRoot !== undefined) {
        const scriptResult = yield* runBunShellTooling(options, appRoot);
        if (scriptResult !== undefined) return scriptResult;
      }
      return yield* Effect.fail(
        new ToolingCompileError({
          message: `Unknown tooling command: ${options.name}.`,
          tool: options.name,
          remediation:
            "Verify the tooling task name, then run `lando app:cache:refresh` after changing tooling configuration.",
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

    const argumentFailure = validateToolingArguments(options.name, task, options.args ?? []);
    if (argumentFailure !== undefined) return yield* Effect.fail(argumentFailure);

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
    const redactionTokens = [
      ...new Set([...collectAppPlanRedactionTokens(plan), ...collectSecretEnvValues(invocation.env)]),
    ];

    const startedAt = Date.now();
    const result = yield* engine.run(invocation, plan, provider);
    const progressEvents = events?._tag === "Some" ? events.value : undefined;

    if (progressEvents !== undefined) {
      const redaction = yield* Effect.serviceOption(RedactionService);
      const redactor =
        redaction._tag === "Some"
          ? yield* redaction.value.forProfile("secrets", { sourceEnv: process.env, redactionTokens })
          : createStandaloneRedactor("secrets", { sourceEnv: process.env, redactionTokens });
      yield* emitToolingOutputProgress({
        events: progressEvents,
        tool: result.tool,
        service: String(result.service),
        exitCode: result.exitCode,
        stdout: redactor.redactString(result.stdout),
        stderr: redactor.redactString(result.stderr),
        durationMs: Date.now() - startedAt,
      });
    }

    return {
      tool: result.tool,
      service: String(result.service),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      redactionTokens,
      ...(progressEvents === undefined ? {} : { rendered: true }),
    };
  });
