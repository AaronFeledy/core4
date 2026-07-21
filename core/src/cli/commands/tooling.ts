import { Effect } from "effect";

import type { ToolingError, ToolingResult } from "@lando/sdk/app";
import type { ShellExecError, ShellScriptOutsideRootError } from "@lando/sdk/errors";
import { NotImplementedError, ToolingCompileError, ToolingExecError } from "@lando/sdk/errors";
import type { LandofileShape, ToolingTaskShape } from "@lando/sdk/schema";

import {
  AppPlanResolver,
  type ConfigService,
  EventService,
  LandofileService,
  RuntimeProviderRegistry,
  ToolingEngine,
  type ToolingInvocation,
} from "@lando/sdk/services";

import { resolveAgentEnvForwardAllowlist } from "../../config/agent-env-policy.ts";
import { type ResolvedAppTarget, loadUserLandofile, loadUserLandofileAt } from "../app-resolution.ts";
import {
  type ProgressEmitter,
  publishTaskComplete,
  publishTaskDetail,
  publishTaskFail,
  publishTaskStart,
  publishTreeComplete,
  publishTreeStart,
} from "../progress.ts";
import { commandAliasConflictError, reservedTopLevelAliasOwner } from "../reserved-aliases.ts";

import { type DiscoveredBunShellScript, discoverBunShellScripts } from "../../landofile/bun-sh-discovery.ts";
import { findAppRoot } from "../../landofile/discovery.ts";
import { withProcessCwd } from "../../runtime/process-cwd.ts";

import { runHostScript } from "../../services/host-tooling-engine.ts";

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
  | AppPlanResolver
  | ConfigService
  | EventService
  | LandofileService
  | RuntimeProviderRegistry
  | ToolingEngine;

const HOST_SERVICE = ":host";

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

const outputLines = (text: string): ReadonlyArray<string> => {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

const emitToolingOutputProgress = (input: {
  readonly events: ProgressEmitter | undefined;
  readonly tool: string;
  readonly service: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}): Effect.Effect<void> => {
  const treeId = `tooling:${input.tool}`;
  const taskId = `${treeId}:${input.service}`;
  return Effect.gen(function* () {
    yield* publishTreeStart(input.events, {
      parentId: treeId,
      label: `Tooling: ${input.tool}`,
      children: [taskId],
    });
    yield* publishTaskStart(input.events, {
      taskId,
      parentId: treeId,
      label: input.service,
    });
    for (const line of outputLines(input.stdout)) {
      yield* publishTaskDetail(input.events, { taskId, stream: "stdout", line });
    }
    for (const line of outputLines(input.stderr)) {
      yield* publishTaskDetail(input.events, { taskId, stream: "stderr", line });
    }
    if (input.exitCode === 0) {
      yield* publishTaskComplete(input.events, {
        taskId,
        summary: "completed with exit code 0",
        durationMs: input.durationMs,
      });
      yield* publishTreeComplete(input.events, {
        parentId: treeId,
        succeeded: 1,
        failed: 0,
        durationMs: input.durationMs,
      });
      return;
    }
    yield* publishTaskFail(input.events, {
      taskId,
      summary: `failed with exit code ${input.exitCode}`,
      exitCode: input.exitCode,
      durationMs: input.durationMs,
    });
    yield* publishTreeComplete(input.events, {
      parentId: treeId,
      succeeded: 0,
      failed: 1,
      durationMs: input.durationMs,
    });
  });
};

const canonicalLookupKey = (name: string): string => (name.startsWith("app:") ? name : `app:${name}`);

const findBunShellScriptForName = (
  scripts: ReadonlyArray<DiscoveredBunShellScript>,
  name: string,
): DiscoveredBunShellScript | undefined => {
  const target = canonicalLookupKey(name);
  return scripts.find((script) => script.id === target);
};

const resolveToolingPlan = (input: {
  readonly landofile: LandofileShape;
  readonly appRoot: string | undefined;
}) =>
  Effect.gen(function* () {
    const planner = yield* AppPlanResolver;
    const registry = yield* RuntimeProviderRegistry;
    const capabilities = yield* registry.capabilities;
    return yield* input.appRoot === undefined
      ? planner.plan(input.landofile, capabilities, { kind: "user" })
      : withProcessCwd(
          input.appRoot,
          Effect.suspend(() => planner.plan(input.landofile, capabilities, { kind: "user" })),
          (cause) =>
            new ToolingCompileError({
              message: `Unable to enter the app directory at ${input.appRoot}.`,
              tool: "tooling",
              cause,
            }),
        );
  });

const runBunShellScript = (
  script: DiscoveredBunShellScript,
  appRoot: string,
  options: RunToolingOptions,
): Effect.Effect<
  RunToolingResult,
  NotImplementedError | ShellExecError | ShellScriptOutsideRootError | ToolingExecError
> =>
  Effect.gen(function* () {
    if (script.service !== HOST_SERVICE) {
      return yield* Effect.fail(
        new NotImplementedError({
          message: `.bun.sh script "${script.id}" declares service "${script.service}"; service-targeted .bun.sh scripts are deferred to Beta.`,
          commandId: "tooling.run",
          remediation:
            "Remove the `service:` field (or set it to `:host`) so the script runs through the host engine, or move the body into a Landofile tooling task that targets the desired service.",
        }),
      );
    }
    const cwd = options.cwd ?? appRoot;
    const env = options.env;
    const result = yield* runHostScript(script.path, [appRoot], {
      cwd,
      ...(env === undefined ? {} : { env }),
    }).pipe(
      Effect.catchTag("ShellExecError", (shellError) =>
        Effect.fail(
          new ToolingExecError({
            message: `Script-backed tooling task ${script.id} failed: ${shellError.message}`,
            tool: script.id,
            ...(shellError.exitCode === undefined ? {} : { exitCode: shellError.exitCode }),
            remediation: `Inspect the tooling task ${script.id} output, fix the script, and rerun the command.`,
            cause: shellError,
          }),
        ),
      ),
    );
    return {
      tool: script.id,
      service: HOST_SERVICE,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    } satisfies RunToolingResult;
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
