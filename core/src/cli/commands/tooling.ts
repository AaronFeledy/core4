import { Effect } from "effect";

import type {
  CapabilityError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
  NoProviderInstalledError,
  ProviderConfigError,
  ProviderUnavailableError,
  ShellExecError,
  ShellScriptOutsideRootError,
} from "@lando/sdk/errors";
import {
  type BunShellScriptEmptyError,
  type BunShellScriptFrontMatterError,
  NotImplementedError,
  ToolingCompileError,
  ToolingExecError,
} from "@lando/sdk/errors";
import type { ToolingTaskShape } from "@lando/sdk/schema";
import {
  AppPlanner,
  LandofileService,
  type ProviderError,
  RuntimeProviderRegistry,
  ToolingEngine,
  type ToolingInvocation,
} from "@lando/sdk/services";

import { type DiscoveredBunShellScript, discoverBunShellScripts } from "../../landofile/bun-sh-discovery.ts";
import { findAppRoot } from "../../landofile/discovery.ts";
import { runHostScript } from "../../services/host-tooling-engine.ts";

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
  | BunShellScriptEmptyError
  | BunShellScriptFrontMatterError
  | CapabilityError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | ShellExecError
  | ShellScriptOutsideRootError
  | ToolingCompileError
  | ToolingExecError;

type RunToolingServices = AppPlanner | LandofileService | RuntimeProviderRegistry | ToolingEngine;

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

const canonicalLookupKey = (name: string): string => (name.startsWith("app:") ? name : `app:${name}`);

const findBunShellScriptForName = (
  scripts: ReadonlyArray<DiscoveredBunShellScript>,
  name: string,
): DiscoveredBunShellScript | undefined => {
  const target = canonicalLookupKey(name);
  return scripts.find((script) => script.id === target);
};

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
          specSection: "§8.5.9",
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
): Effect.Effect<RunToolingResult, RunToolingError, RunToolingServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const planner = yield* AppPlanner;
    const registry = yield* RuntimeProviderRegistry;
    const engine = yield* ToolingEngine;

    const landofile = yield* landofileService.discover;
    const toolingLookupKey = options.name.startsWith("app:") ? options.name.slice(4) : options.name;
    const task = landofile.tooling?.[toolingLookupKey];

    if (task === undefined) {
      const appRoot = yield* Effect.promise(() => findAppRoot(options.cwd ?? process.cwd()));
      if (appRoot !== undefined) {
        const scripts = yield* discoverBunShellScripts({ appRoot });
        const script = findBunShellScriptForName(scripts, options.name);
        if (script !== undefined) {
          return yield* runBunShellScript(script, appRoot, options);
        }
      }
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

    return {
      tool: result.tool,
      service: String(result.service),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
