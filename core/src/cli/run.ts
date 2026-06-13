import { dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { execute } from "@oclif/core";
import type { Command } from "@oclif/core";
import { Cause, Effect, Exit, type Layer } from "effect";

import {
  type LandoRuntimeBootstrapError,
  NotImplementedError,
  RendererSelectionError,
} from "@lando/sdk/errors";
import type {
  AppPlanner,
  EventService,
  FileSystem,
  GlobalAppService,
  PluginRegistry,
  Renderer,
  RuntimeProviderRegistry,
  ScratchAppService,
} from "@lando/sdk/services";

import { cliRuntimeOptions } from "../runtime/cli-options.ts";
import { makeLandoRuntime } from "../runtime/layer.ts";

import { type BugReportContext, type RendererMode, formatBugReport } from "./bug-report.ts";
import { refreshAppCache, renderAppCacheRefreshResult } from "./commands/app-cache-refresh.ts";
import {
  type AppConfigLintFormat,
  appConfigLint,
  renderConfigLintResult,
} from "./commands/app-config-lint.ts";
import {
  type AppConfigTranslateFormat,
  appConfigTranslate,
  renderConfigTranslateResult,
} from "./commands/app-config-translate.ts";
import { appConfig, renderAppConfigResult } from "./commands/app-config.ts";
import {
  type AppIncludesUpdateFormat,
  appIncludesUpdate,
  renderIncludesUpdateResult,
} from "./commands/app-includes-update.ts";
import {
  type AppIncludesVerifyFormat,
  appIncludesVerify,
  renderIncludesVerifyResult,
} from "./commands/app-includes-verify.ts";
import { metaBun, metaX, renderMetaBunResult, renderMetaXResult } from "./commands/bun.ts";
import { config, renderConfigResult } from "./commands/config.ts";
import { destroyApp, renderDestroyAppResult } from "./commands/destroy.ts";
import { doctorReport, renderDoctorReport, renderDoctorReportAsNdjson } from "./commands/doctor-report.ts";
import { execApp, renderExecAppResult } from "./commands/exec.ts";
import { infoApp, renderInfoAppResult } from "./commands/info.ts";
import { initApp } from "./commands/init.ts";
import { listServices, renderAppsListResult } from "./commands/list.ts";
import { logsApp, renderLogsAppResult } from "./commands/logs.ts";
import { globalConfig, renderGlobalConfigResult } from "./commands/meta/global-config.ts";
import { globalDestroy, renderGlobalDestroyResult } from "./commands/meta/global-destroy.ts";
import { globalInstall, renderGlobalInstallResult } from "./commands/meta/global-install.ts";
import { globalStart, renderGlobalStartResult } from "./commands/meta/global-start.ts";
import { globalStatus, renderGlobalStatusResult } from "./commands/meta/global-status.ts";
import { globalStop, renderGlobalStopResult } from "./commands/meta/global-stop.ts";
import { globalUninstall, renderGlobalUninstallResult } from "./commands/meta/global-uninstall.ts";
import { pluginAdd, renderPluginAddResult } from "./commands/plugin-add.ts";
import { pluginRemove, renderPluginRemoveResult } from "./commands/plugin-remove.ts";
import {
  pluginTrust,
  pluginTrustAuthoringRoot,
  pluginTrustList,
  pluginTrustRevoke,
  renderPluginTrustAuthoringRootResult,
  renderPluginTrustListResult,
  renderPluginTrustResult,
  renderPluginTrustRevokeResult,
} from "./commands/plugin-trust.ts";
import { poweroff, renderPoweroffResult } from "./commands/poweroff.ts";
import { rebuildApp, renderRebuildAppResult } from "./commands/rebuild.ts";
import { renderRestartAppResult, restartApp } from "./commands/restart.ts";
import {
  type ScratchStartOptions,
  normalizeScratchStartArgv,
  renderScratchDestroyResult,
  renderScratchGcReport,
  renderScratchInfoResult,
  renderScratchListResult,
  renderScratchLogsResult,
  renderScratchStartResult,
  renderScratchStopResult,
  scratchDestroy,
  scratchGc,
  scratchIdFromInput,
  scratchInfo,
  scratchList,
  scratchListFormatFromInput,
  scratchLogs,
  scratchStart,
  scratchStartOptionsFromInput,
  scratchStop,
} from "./commands/scratch.ts";
import { renderShellAppResult, shellApp } from "./commands/shell.ts";
import { renderShellenv } from "./commands/shellenv.ts";
import { renderStartAppResult, startApp } from "./commands/start.ts";
import { renderStopAppResult, stopApp } from "./commands/stop.ts";
import { renderRunToolingResult, runTooling } from "./commands/tooling.ts";
import { renderUninstallResult, uninstall } from "./commands/uninstall.ts";
import { update } from "./commands/update.ts";
import { version as versionOperation } from "./commands/version.ts";
import { notImplementedErrorForCommand } from "./oclif/command-base.ts";
import { logsDeferredErrorFromInput, logsOptionsFromInput } from "./oclif/commands/app/logs.ts";
import { initOptionsFromInput } from "./oclif/commands/apps/init.ts";
import { keepVolumesFromInput } from "./oclif/commands/apps/scratch/destroy.ts";
import { pruneFromInput } from "./oclif/commands/apps/scratch/gc.ts";
import { globalConfigFormatFromInput } from "./oclif/commands/meta/global/config.ts";
import { globalDestroyOptionsFromInput } from "./oclif/commands/meta/global/destroy.ts";
import { globalInstallOptionsFromInput } from "./oclif/commands/meta/global/install.ts";
import { globalStartOptionsFromInput } from "./oclif/commands/meta/global/start.ts";
import {
  globalStatusFormatFromInput,
  globalStatusOptionsFromInput,
} from "./oclif/commands/meta/global/status.ts";
import { globalUninstallOptionsFromInput } from "./oclif/commands/meta/global/uninstall.ts";
import { setupSpec } from "./oclif/commands/meta/setup.ts";
import { shellenvShellFromInput } from "./oclif/commands/meta/shellenv.ts";
import { uninstallOptionsFromInput } from "./oclif/commands/meta/uninstall.ts";
import compiledCommands from "./oclif/compiled-commands.ts";
import { loadCompiledManifest } from "./oclif/manifest.ts";
import {
  makeRendererServiceLiveForMode,
  resolveCliDeprecationWarnings,
  resolveCliRendererMode,
  runWithRendererHandling,
  writeDiagnosticLine,
  writeResultLine,
} from "./renderer-boundary.ts";

const version = "@lando/core/0.0.0";

type CompiledCommand = Command.Class;

const commandEntries: Array<[string, CompiledCommand]> = Object.entries(compiledCommands).sort(
  ([left], [right]) => left.localeCompare(right),
);

const compiledManifest = loadCompiledManifest();

const commandName = (id: string, command: CompiledCommand): string => {
  const aliases = command.aliases;
  if (!aliases || aliases.length === 0) return id;
  const nonFlagAlias = aliases.find((alias) => !alias.startsWith("-"));
  if (nonFlagAlias !== undefined) return nonFlagAlias;
  return aliases[0] ?? id;
};

const findCommand = (name: string): [string, CompiledCommand] | undefined =>
  commandEntries.find(([id, command]) => id === name || command.aliases?.includes(name));

interface CompiledCommandInput {
  readonly argv: ReadonlyArray<string>;
  readonly flags: Record<string, unknown>;
  readonly args: Record<string, unknown>;
  readonly rendererMode?: RendererMode;
  readonly signal?: AbortSignal;
}

type OclifFlagDefinition = {
  readonly type?: string;
  readonly char?: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly multiple?: boolean;
  readonly options?: ReadonlyArray<string>;
};

type OclifArgDefinition = Record<string, unknown>;

const commandSpecForId = (commandId: string): CompiledCommand | undefined =>
  (compiledCommands as Readonly<Record<string, CompiledCommand>>)[commandId];

const flagDefinitionsForCommand = (command: CompiledCommand): Readonly<Record<string, OclifFlagDefinition>> =>
  (command as { flags?: Readonly<Record<string, OclifFlagDefinition>> }).flags ?? {};

const argDefinitionsForCommand = (command: CompiledCommand): Readonly<Record<string, OclifArgDefinition>> =>
  (command as { args?: Readonly<Record<string, OclifArgDefinition>> }).args ?? {};

const flagNameByToken = (
  flags: Readonly<Record<string, OclifFlagDefinition>>,
): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  for (const [name, definition] of Object.entries(flags)) {
    out.set(`--${name}`, name);
    for (const alias of definition.aliases ?? []) out.set(`--${alias}`, name);
    if (definition.char !== undefined) out.set(`-${definition.char}`, name);
  }
  return out;
};

const parseFlagValue = (name: string, value: string | boolean): string | number | boolean | undefined => {
  if (name === "tail" && typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return value;
};

const setParsedFlag = (
  flags: Record<string, unknown>,
  name: string,
  value: string | boolean,
  definition: OclifFlagDefinition,
): void => {
  const parsed = parseFlagValue(name, value);
  // undefined means the value was unparseable (e.g. non-numeric --tail): leave the flag unset.
  if (parsed === undefined) return;
  if (definition.multiple === true) {
    const existing = flags[name];
    flags[name] = Array.isArray(existing) ? [...existing, parsed] : [parsed];
    return;
  }
  flags[name] = parsed;
};

export const compiledCommandInputFromArgv = (
  commandId: string,
  argv: ReadonlyArray<string>,
  options: { readonly rendererMode?: RendererMode; readonly signal?: AbortSignal } = {},
): CompiledCommandInput => {
  const command = commandSpecForId(commandId);
  if (command === undefined) return { argv, flags: {}, args: {}, ...options };
  const normalizedArgv = commandId === "apps:scratch:start" ? normalizeScratchStartArgv(argv) : argv;
  const flagDefinitions = flagDefinitionsForCommand(command);
  const flagTokens = flagNameByToken(flagDefinitions);
  const argNames = Object.keys(argDefinitionsForCommand(command));
  const flags: Record<string, unknown> = {};
  const positionals: string[] = [];

  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const arg = normalizedArgv[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      positionals.push(...normalizedArgv.slice(index + 1));
      break;
    }

    const equalsIndex = arg.indexOf("=");
    const token = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const flagName = flagTokens.get(token);
    if (flagName !== undefined) {
      const definition = flagDefinitions[flagName] ?? {};
      if (definition.type === "boolean") {
        setParsedFlag(flags, flagName, true, definition);
        continue;
      }
      const value = equalsIndex === -1 ? normalizedArgv[index + 1] : arg.slice(equalsIndex + 1);
      if (value === undefined) continue;
      setParsedFlag(flags, flagName, value, definition);
      if (equalsIndex === -1) index += 1;
      continue;
    }

    if (arg.startsWith("-")) continue;
    positionals.push(arg);
  }

  const args: Record<string, unknown> = {};
  for (const [index, name] of argNames.entries()) {
    const value = positionals[index];
    if (value !== undefined) args[name] = value;
  }

  return { argv: normalizedArgv, flags, args, ...options };
};

const printRootHelp = (): void => {
  const lines = [
    `Lando v4 core: runtime, planner, OCLIF adapter, and library API.

VERSION
  ${version} ${process.platform}-${process.arch} node-${process.version}

USAGE
  $ lando [COMMAND]

TOPICS
  app   Operate on the current Lando app.
  apps  Discover and operate across Lando apps on the host.
  meta  Operate on Lando itself: config, plugins, host setup.

COMMANDS`,
  ];
  for (const [id, command] of commandEntries) {
    const name = commandName(id, command);
    if (!name.includes(":")) {
      lines.push(`  ${name.padEnd(22)} ${command.description ?? ""}`);
    }
  }
  emitResultLine(lines.join("\n"));
};

const printCommandHelp = (id: string, command: CompiledCommand): void => {
  emitResultLine(`${command.description ?? command.summary ?? id}

USAGE
  $ lando ${commandName(id, command)}

ALIASES
  ${[id, ...(command.aliases ?? [])].join(", ")}`);
};

let activeRendererMode: RendererMode = "lando";
let activeDeprecationWarnings = true;
let activeCommandId = "cli:unknown";

const setActiveRendererMode = (mode: RendererMode): void => {
  activeRendererMode = mode;
};

const setActiveDeprecationWarnings = (enabled: boolean): void => {
  activeDeprecationWarnings = enabled;
};

const setActiveCommandId = (commandId: string): void => {
  activeCommandId = commandId;
};

const commandErrorMessage = (error: unknown, commandId: string = activeCommandId): string => {
  const context: BugReportContext = { commandId };
  return formatBugReport({ error, context, rendererMode: activeRendererMode });
};

const emitResultLine = (text: string): void => {
  Effect.runSync(
    writeResultLine(text).pipe(Effect.provide(makeRendererServiceLiveForMode(activeRendererMode))),
  );
};

const emitDiagnosticLine = (text: string): void => {
  Effect.runSync(
    writeDiagnosticLine(text).pipe(Effect.provide(makeRendererServiceLiveForMode(activeRendererMode))),
  );
};

/**
 * Validate a compiled-dispatch argv against a command's flag/arg definitions the
 * same way OCLIF's parser rejects malformed invocations, so the `$bunfs` binary
 * stays at parity with source mode for setup/shellenv/uninstall. Returns the
 * OCLIF-equivalent diagnostic, or `undefined` when valid.
 * Mirrors the consumption rules in `compiledCommandInputFromArgv`: a value flag
 * consumes the following token (even a `-`-prefixed one) as its value, and `--`
 * terminates flag parsing so everything after it is positional.
 */
const flagTokenOf = (arg: string): string => {
  const equalsIndex = arg.indexOf("=");
  return equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
};

const invocationParityError = (commandId: string, argv: ReadonlyArray<string>): string | undefined => {
  const command = commandSpecForId(commandId);
  if (command === undefined) return undefined;
  const flagDefinitions = flagDefinitionsForCommand(command);
  const flagTokens = flagNameByToken(flagDefinitions);
  const maxPositionals = Object.keys(argDefinitionsForCommand(command)).length;
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      for (let rest = index + 1; rest < argv.length; rest += 1) {
        const value = argv[rest];
        if (value !== undefined) positionals.push(value);
      }
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const equalsIndex = arg.indexOf("=");
    const token = flagTokenOf(arg);
    const flagName = flagTokens.get(token);
    if (flagName === undefined) return `Nonexistent flag: ${token}`;
    const definition = flagDefinitions[flagName] ?? {};
    if (definition.type === "boolean") {
      // A boolean flag takes no value; `--flag=value` is a parse error in OCLIF.
      if (equalsIndex !== -1) return `Unexpected argument: ${arg.slice(equalsIndex + 1)}`;
      continue;
    }
    if (equalsIndex !== -1) continue;
    const next = argv[index + 1];
    const nextIsFlag = next !== undefined && next !== "-" && flagTokens.has(flagTokenOf(next));
    // OCLIF reports a missing value when the next token is absent or is itself a
    // recognized flag; an option flag's diagnostic enumerates its allowed values.
    if (next === undefined || nextIsFlag) {
      return definition.options === undefined
        ? `Flag ${token} expects a value`
        : `Flag ${token} expects one of these values: ${definition.options.join(", ")}`;
    }
    index += 1;
  }
  const extra = positionals[maxPositionals];
  if (extra !== undefined) return `Unexpected argument: ${extra}`;
  return undefined;
};

const rejectInvalidInvocation = (commandId: string, argv: ReadonlyArray<string>): boolean => {
  const diagnostic = invocationParityError(commandId, argv);
  if (diagnostic === undefined) return false;
  emitDiagnosticLine(diagnostic);
  process.exitCode = 2;
  return true;
};

const runCompiledCommand = <A, E, R, RE>(
  operation: Effect.Effect<A, E, R>,
  runtime: Layer.Layer<Exclude<R, Renderer>, RE>,
  render: (value: A) => string | undefined,
  options: { readonly renderEvents?: boolean; readonly plainTaskEvents?: "detail-only" } = {},
): Promise<void> =>
  runWithRendererHandling(operation, {
    runtime,
    rendererMode: activeRendererMode,
    deprecationWarnings: activeDeprecationWarnings,
    ...(options.renderEvents === undefined ? {} : { renderEvents: options.renderEvents }),
    ...(options.plainTaskEvents === undefined ? {} : { plainTaskEvents: options.plainTaskEvents }),
    render,
    formatError: (error) => commandErrorMessage(error),
  });

const runWithProcessAbortSignal = async (run: (signal: AbortSignal) => Promise<void>): Promise<void> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await run(controller.signal);
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
};

const runStart = (): Promise<void> =>
  runWithProcessAbortSignal((signal) =>
    runCompiledCommand(
      startApp({ signal }),
      makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
      renderStartAppResult,
    ),
  );

const runStop = (): Promise<void> =>
  runCompiledCommand(
    stopApp(),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    renderStopAppResult,
  );

const runDynamicTooling = (argv: ReadonlyArray<string>): Promise<void> => {
  const name = argv[0];
  if (name === undefined) throw new Error("Missing tooling command name");
  return runCompiledCommand(
    runTooling({ name, args: argv.slice(1), renderProgress: true }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    renderRunToolingResult,
    { renderEvents: true, plainTaskEvents: "detail-only" },
  );
};

const runInfo = (): Promise<void> =>
  runCompiledCommand(
    infoApp(),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    renderInfoAppResult,
  );

const runDestroy = (argv: ReadonlyArray<string>): Promise<void> => {
  const volumes = argv.includes("--volumes");
  const yes = argv.includes("--yes") || argv.includes("-y");
  return runCompiledCommand(
    destroyApp({ volumes, yes }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    renderDestroyAppResult,
  );
};

const parseProviderFlag = (argv: ReadonlyArray<string>): string | undefined => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg.startsWith("--provider=")) return arg.slice("--provider=".length);
    if (arg === "--provider") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) return undefined;
      return next;
    }
  }
  return undefined;
};

const parseFixFlag = (argv: ReadonlyArray<string>): boolean => argv.some((arg) => arg === "--fix");

const runSetup = async (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("meta:setup", argv)) return;
  const installDir = dirname(process.execPath);
  const input = compiledCommandInputFromArgv("meta:setup", argv);
  const hostProxy = input.flags["host-proxy"];
  if (hostProxy !== undefined && hostProxy !== "auto" && hostProxy !== "none") {
    emitDiagnosticLine("Invalid --host-proxy value. Expected one of: auto, none.");
    process.exitCode = 2;
    return;
  }
  const exit = await Effect.runPromiseExit(
    setupSpec
      .run({
        installDir,
        flags: input.flags,
      })
      .pipe(
        Effect.provide(
          makeLandoRuntime(cliRuntimeOptions({ bootstrap: "provider", plugins: { policy: "discovery" } })),
        ),
      ),
  );
  if (Exit.isSuccess(exit)) {
    const rendered = setupSpec.render?.(exit.value);
    if (rendered !== undefined) emitResultLine(rendered);
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  const message = failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause);
  emitDiagnosticLine(
    activeRendererMode === "json" ? message : `${message}\nLANDO_INSTALL_DIR="${installDir}"`,
  );
  process.exitCode = 1;
};

const runRestart = (): Promise<void> =>
  runWithProcessAbortSignal((signal) =>
    runCompiledCommand(
      restartApp({ signal }),
      makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
      renderRestartAppResult,
    ),
  );

const runRebuild = (): Promise<void> =>
  runWithProcessAbortSignal((signal) =>
    runCompiledCommand(
      rebuildApp({ signal }),
      makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
      renderRebuildAppResult,
    ),
  );

const runLogs = (argv: ReadonlyArray<string>): Promise<void> => {
  const input = compiledCommandInputFromArgv("app:logs", argv);
  const deferredError = logsDeferredErrorFromInput(input);
  if (deferredError !== undefined) {
    emitDiagnosticLine(commandErrorMessage(deferredError));
    process.exitCode = 1;
    return Promise.resolve();
  }
  return runCompiledCommand(
    logsApp(logsOptionsFromInput(input)),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    renderLogsAppResult,
  );
};

const parseAppConfigArgv = (argv: ReadonlyArray<string>): { readonly format: "json" | "table" } => {
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    const formatMatch = parseStringFlag(argv, i, "format");
    if (formatMatch !== undefined) {
      const value = formatMatch.value;
      if (value === "json" || value === "table") return { format: value };
      i += formatMatch.consumed;
      continue;
    }
    i += 1;
  }
  return { format: "table" };
};

const runAppConfig = (argv: ReadonlyArray<string>): Promise<void> => {
  const { format } = parseAppConfigArgv(argv);
  return runCompiledCommand(
    appConfig(),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    (value) => renderAppConfigResult(value, format),
  );
};

const parseAppConfigLintArgv = (argv: ReadonlyArray<string>): { readonly format: AppConfigLintFormat } => {
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    const formatMatch = parseStringFlag(argv, i, "format");
    if (formatMatch !== undefined) {
      const value = formatMatch.value;
      if (value === "json" || value === "text") return { format: value };
      i += formatMatch.consumed;
      continue;
    }
    i += 1;
  }
  return { format: "text" };
};

const runAppConfigLint = (argv: ReadonlyArray<string>): Promise<void> => {
  const { format } = parseAppConfigLintArgv(argv);
  return runCompiledCommand(
    appConfigLint(),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    (value) => renderConfigLintResult(value, format),
  );
};

const parseAppConfigTranslateArgv = (
  argv: ReadonlyArray<string>,
): { readonly write: boolean; readonly format: AppConfigTranslateFormat } => {
  let write = false;
  let format: AppConfigTranslateFormat = "text";
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (arg === "--write") {
      write = true;
      i += 1;
      continue;
    }
    const formatMatch = parseStringFlag(argv, i, "format");
    if (formatMatch !== undefined) {
      if (formatMatch.value === "json" || formatMatch.value === "text") format = formatMatch.value;
      i += formatMatch.consumed;
      continue;
    }
    i += 1;
  }
  return { write, format };
};

const runAppConfigTranslate = (argv: ReadonlyArray<string>): Promise<void> => {
  const { write, format } = parseAppConfigTranslateArgv(argv);
  return runCompiledCommand(
    appConfigTranslate({ write }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    (value) => renderConfigTranslateResult(value, format),
  );
};

const parseAppIncludesUpdateArgv = (
  argv: ReadonlyArray<string>,
): { readonly check: boolean; readonly format: AppIncludesUpdateFormat } => {
  const check = argv.some((arg) => arg === "--check");
  let format: AppIncludesUpdateFormat = "text";
  let i = 0;
  while (i < argv.length) {
    const match = parseStringFlag(argv, i, "format");
    if (match !== undefined) {
      if (match.value === "json" || match.value === "text") {
        format = match.value;
      }
      i += match.consumed;
      continue;
    }
    i += 1;
  }
  return { check, format };
};

const runAppIncludesUpdate = (argv: ReadonlyArray<string>): Promise<void> => {
  const { check, format } = parseAppIncludesUpdateArgv(argv);
  return runCompiledCommand(
    appIncludesUpdate({ check }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    (value) => renderIncludesUpdateResult(value, format),
  );
};

const parseAppIncludesVerifyArgv = (
  argv: ReadonlyArray<string>,
): { readonly format: AppIncludesVerifyFormat } => {
  let format: AppIncludesVerifyFormat = "text";
  let i = 0;
  while (i < argv.length) {
    const match = parseStringFlag(argv, i, "format");
    if (match !== undefined) {
      if (match.value === "json" || match.value === "text") {
        format = match.value;
      }
      i += match.consumed;
      continue;
    }
    i += 1;
  }
  return { format };
};

const runAppIncludesVerify = (argv: ReadonlyArray<string>): Promise<void> => {
  const { format } = parseAppIncludesVerifyArgv(argv);
  return runCompiledCommand(
    appIncludesVerify(),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    (value) => renderIncludesVerifyResult(value, format),
  );
};

const runAppCacheRefresh = (): Promise<void> =>
  runCompiledCommand(
    refreshAppCache(),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    renderAppCacheRefreshResult,
  );

const runDoctor = async (argv: ReadonlyArray<string>): Promise<void> => {
  const flagProvider = parseProviderFlag(argv);
  const fix = parseFixFlag(argv);
  const app = argv.some((arg) => arg === "--app");
  await runCompiledCommand(
    doctorReport({
      ...(flagProvider === undefined ? {} : { flagProviderId: flagProvider }),
      ...(fix ? { fix: true } : {}),
      ...(app ? { app: true } : {}),
    }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "provider", plugins: { policy: "discovery" } })),
    (value) =>
      activeRendererMode === "json" ? renderDoctorReportAsNdjson(value) : renderDoctorReport(value),
  );
};

interface ParsedExecArgv {
  readonly service?: string;
  readonly user?: string;
  readonly cwd?: string;
  readonly command: ReadonlyArray<string>;
}

const parseStringFlag = (
  argv: ReadonlyArray<string>,
  index: number,
  longName: string,
  shortName?: string,
): { readonly value: string; readonly consumed: number } | undefined => {
  const arg = argv[index];
  if (arg === undefined) return undefined;
  const longEq = `--${longName}=`;
  if (arg.startsWith(longEq)) return { value: arg.slice(longEq.length), consumed: 1 };
  if (arg === `--${longName}` || (shortName !== undefined && arg === `-${shortName}`)) {
    const next = argv[index + 1];
    if (next === undefined) return undefined;
    return { value: next, consumed: 2 };
  }
  if (shortName !== undefined) {
    const shortEq = `-${shortName}=`;
    if (arg.startsWith(shortEq)) return { value: arg.slice(shortEq.length), consumed: 1 };
  }
  return undefined;
};

const parseExecArgv = (argv: ReadonlyArray<string>): ParsedExecArgv => {
  let service: string | undefined;
  let user: string | undefined;
  let cwd: string | undefined;
  const command: string[] = [];
  let i = 0;
  let positionalStarted = false;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (!positionalStarted && arg === "--") {
      positionalStarted = true;
      i += 1;
      continue;
    }
    if (!positionalStarted && (arg.startsWith("--") || (arg.startsWith("-") && arg.length > 1))) {
      const serviceMatch = parseStringFlag(argv, i, "service", "s");
      if (serviceMatch !== undefined) {
        service = serviceMatch.value;
        i += serviceMatch.consumed;
        continue;
      }
      const userMatch = parseStringFlag(argv, i, "user", "u");
      if (userMatch !== undefined) {
        user = userMatch.value;
        i += userMatch.consumed;
        continue;
      }
      const cwdMatch = parseStringFlag(argv, i, "cwd");
      if (cwdMatch !== undefined) {
        cwd = cwdMatch.value;
        i += cwdMatch.consumed;
        continue;
      }
      positionalStarted = true;
      command.push(arg);
      i += 1;
      continue;
    }
    positionalStarted = true;
    command.push(arg);
    i += 1;
  }
  return {
    ...(service === undefined ? {} : { service }),
    ...(user === undefined ? {} : { user }),
    ...(cwd === undefined ? {} : { cwd }),
    command,
  };
};

const runExec = (argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parseExecArgv(argv);
  return runCompiledCommand(
    execApp({
      command: parsed.command,
      ...(parsed.service === undefined ? {} : { service: parsed.service }),
      ...(parsed.user === undefined ? {} : { user: parsed.user }),
      ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
    }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    renderExecAppResult,
  );
};

interface ParsedSshArgv {
  readonly service?: string;
  readonly user?: string;
  readonly subsystem?: string;
  readonly sidecar: boolean;
  readonly command: ReadonlyArray<string>;
}

const parseSshArgv = (argv: ReadonlyArray<string>): ParsedSshArgv => {
  let service: string | undefined;
  let user: string | undefined;
  let subsystem: string | undefined;
  let sidecar = false;
  const command: string[] = [];
  let i = 0;
  let positionalStarted = false;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (!positionalStarted && arg === "--") {
      positionalStarted = true;
      i += 1;
      continue;
    }
    if (!positionalStarted && (arg.startsWith("--") || (arg.startsWith("-") && arg.length > 1))) {
      const serviceMatch = parseStringFlag(argv, i, "service", "s");
      if (serviceMatch !== undefined) {
        service = serviceMatch.value;
        i += serviceMatch.consumed;
        continue;
      }
      const userMatch = parseStringFlag(argv, i, "user", "u");
      if (userMatch !== undefined) {
        user = userMatch.value;
        i += userMatch.consumed;
        continue;
      }
      const subsystemMatch = parseStringFlag(argv, i, "subsystem");
      if (subsystemMatch !== undefined) {
        subsystem = subsystemMatch.value;
        i += subsystemMatch.consumed;
        continue;
      }
      if (arg === "--sidecar") {
        sidecar = true;
        i += 1;
        continue;
      }
      positionalStarted = true;
      command.push(arg);
      i += 1;
      continue;
    }
    positionalStarted = true;
    command.push(arg);
    i += 1;
  }
  return {
    ...(service === undefined ? {} : { service }),
    ...(user === undefined ? {} : { user }),
    ...(subsystem === undefined ? {} : { subsystem }),
    sidecar,
    command,
  };
};

const sshDeferred = (kind: "subsystem" | "sidecar"): string =>
  commandErrorMessage(
    new NotImplementedError({
      message: `\`lando ssh --${kind}\`: SSH ${kind} support is deferred to Beta. Alpha \`ssh\` is provider-exec TTY command behavior only.`,
      commandId: "app:ssh",
      remediation:
        "Drop the unsupported flag. Alpha `lando ssh` runs the default service shell (`sh -l`) inside the selected service via provider-exec. SSH sidecar/subsystem support lands in Beta.",
    }),
  );

const runSsh = async (argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parseSshArgv(argv);
  if (parsed.subsystem !== undefined) {
    emitDiagnosticLine(sshDeferred("subsystem"));
    process.exitCode = 1;
    return;
  }
  if (parsed.sidecar) {
    emitDiagnosticLine(sshDeferred("sidecar"));
    process.exitCode = 1;
    return;
  }
  const command = parsed.command.length === 0 ? ["sh", "-l"] : parsed.command;
  await runCompiledCommand(
    execApp({
      command,
      interactive: true,
      tty: true,
      ...(parsed.service === undefined ? {} : { service: parsed.service }),
      ...(parsed.user === undefined ? {} : { user: parsed.user }),
    }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    renderExecAppResult,
  );
};

const parseShellArgv = (
  argv: ReadonlyArray<string>,
): { readonly service?: string; readonly host: boolean } => {
  let service: string | undefined;
  let host = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (arg === "--host") {
      host = true;
      i += 1;
      continue;
    }
    const match = parseStringFlag(argv, i, "service", "s");
    if (match !== undefined) {
      service = match.value;
      i += match.consumed;
      continue;
    }
    if (!arg.startsWith("-") && service === undefined) {
      service = arg;
    }
    i += 1;
  }
  return { ...(service === undefined ? {} : { service }), host };
};

const runShell = (
  argv: ReadonlyArray<string>,
  options: { readonly signal?: AbortSignal } = {},
): Promise<void> => {
  const parsed = parseShellArgv(argv);
  return runCompiledCommand(
    shellApp({
      host: parsed.host,
      ...(parsed.service === undefined ? {} : { service: parsed.service }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    renderShellAppResult,
  );
};

const runAppsList = async (argv: ReadonlyArray<string>): Promise<void> => {
  let format: "json" | "table" = "table";
  for (let i = 0; i < argv.length; i += 1) {
    const m = parseStringFlag(argv, i, "format");
    if (m !== undefined && (m.value === "json" || m.value === "table")) {
      format = m.value;
      i += m.consumed - 1;
    }
  }
  return runCompiledCommand(
    listServices(),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    (value) => renderAppsListResult(value, format),
  );
};

const runAppsPoweroff = async (argv: ReadonlyArray<string>): Promise<void> => {
  const keepGlobal = argv.includes("--keep-global");
  const keepScratch = argv.includes("--keep-scratch");
  const yes = argv.includes("--yes") || argv.includes("-y");
  return runCompiledCommand(
    poweroff({ keepGlobal, keepScratch, yes }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderPoweroffResult,
  );
};

const runMetaConfig = async (argv: ReadonlyArray<string>): Promise<void> => {
  let format: "json" | "yaml" | "table" = "table";
  let path: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const fmtMatch = parseStringFlag(argv, i, "format");
    if (fmtMatch !== undefined) {
      if (fmtMatch.value === "json" || fmtMatch.value === "yaml" || fmtMatch.value === "table") {
        format = fmtMatch.value;
      }
      i += fmtMatch.consumed - 1;
      continue;
    }
    const pathMatch = parseStringFlag(argv, i, "path");
    if (pathMatch !== undefined) {
      path = pathMatch.value;
      i += pathMatch.consumed - 1;
      continue;
    }
    if (!arg.startsWith("-")) positionals.push(arg);
  }
  const [subcommand, key] = positionals;
  return runCompiledCommand(
    config({
      ...(subcommand === "get" || subcommand === "view" || subcommand === "telemetry" ? { subcommand } : {}),
      ...(key === undefined ? {} : { key }),
      ...(path === undefined ? {} : { path }),
      format,
    } as Parameters<typeof config>[0]),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderConfigResult,
  );
};

const globalRuntimeLayer = () =>
  makeLandoRuntime(
    cliRuntimeOptions({ bootstrap: "global", plugins: { policy: "discovery" } }),
  ) as Layer.Layer<
    GlobalAppService | PluginRegistry | RuntimeProviderRegistry | AppPlanner | FileSystem | EventService,
    LandoRuntimeBootstrapError
  >;

const scratchRuntimeLayer = () =>
  makeLandoRuntime(
    cliRuntimeOptions({ bootstrap: "scratch", plugins: { policy: "discovery" } }),
  ) as Layer.Layer<ScratchAppService, LandoRuntimeBootstrapError>;

const runScratchEffect = <A>(
  operation: Effect.Effect<A, unknown, ScratchAppService>,
  render: (result: A) => string | undefined,
): Promise<void> =>
  runWithRendererHandling(operation, {
    runtime: scratchRuntimeLayer(),
    rendererMode: activeRendererMode,
    deprecationWarnings: activeDeprecationWarnings,
    render,
    formatError: (error) => commandErrorMessage(error),
  });

export const parseScratchStartArgv = (argv: ReadonlyArray<string>): ScratchStartOptions =>
  scratchStartOptionsFromInput(compiledCommandInputFromArgv("apps:scratch:start", argv));

const scratchCommandInput = (
  commandId: string,
  argv: ReadonlyArray<string>,
  options: { readonly rendererMode?: RendererMode; readonly signal?: AbortSignal } = {},
): CompiledCommandInput =>
  compiledCommandInputFromArgv(commandId, argv, { rendererMode: activeRendererMode, ...options });

const runAppsScratchStart = (argv: ReadonlyArray<string>): Promise<void> =>
  runWithProcessAbortSignal((signal) => {
    const input = scratchCommandInput("apps:scratch:start", argv, { signal });
    return runScratchEffect(scratchStart(scratchStartOptionsFromInput(input)), renderScratchStartResult);
  });

const runAppsScratchStop = async (argv: ReadonlyArray<string>): Promise<void> => {
  const input = scratchCommandInput("apps:scratch:stop", argv);
  await runScratchEffect(scratchStop(scratchIdFromInput(input)), renderScratchStopResult);
};

const runAppsScratchDestroy = async (argv: ReadonlyArray<string>): Promise<void> => {
  const input = scratchCommandInput("apps:scratch:destroy", argv);
  await runScratchEffect(
    scratchDestroy(scratchIdFromInput(input), { keepVolumes: keepVolumesFromInput(input) }),
    renderScratchDestroyResult,
  );
};

const runAppsScratchList = async (argv: ReadonlyArray<string>): Promise<void> => {
  const input = scratchCommandInput("apps:scratch:list", argv);
  await runScratchEffect(scratchList(), (result) =>
    renderScratchListResult(result, scratchListFormatFromInput(input)),
  );
};

const runAppsScratchInfo = async (argv: ReadonlyArray<string>): Promise<void> => {
  const input = scratchCommandInput("apps:scratch:info", argv);
  await runScratchEffect(scratchInfo(scratchIdFromInput(input)), (result) =>
    renderScratchInfoResult(result, scratchListFormatFromInput(input)),
  );
};

const runAppsScratchLogs = async (argv: ReadonlyArray<string>): Promise<void> => {
  const input = scratchCommandInput("apps:scratch:logs", argv);
  await runScratchEffect(scratchLogs(scratchIdFromInput(input)), renderScratchLogsResult);
};

const runAppsScratchGc = async (argv: ReadonlyArray<string>): Promise<void> => {
  const input = scratchCommandInput("apps:scratch:gc", argv);
  await runScratchEffect(scratchGc({ prune: pruneFromInput(input) }), renderScratchGcReport);
};

const runMetaGlobalStart = (argv: ReadonlyArray<string>): Promise<void> =>
  runWithProcessAbortSignal((signal) =>
    runCompiledCommand(
      globalStart(
        globalStartOptionsFromInput(compiledCommandInputFromArgv("meta:global:start", argv, { signal })),
      ),
      globalRuntimeLayer(),
      renderGlobalStartResult,
    ),
  );

const runMetaGlobalStop = (): Promise<void> =>
  runCompiledCommand(globalStop(), globalRuntimeLayer(), renderGlobalStopResult);

const runMetaGlobalStatus = (argv: ReadonlyArray<string>): Promise<void> => {
  const input = compiledCommandInputFromArgv("meta:global:status", argv);
  return runCompiledCommand(
    globalStatus(globalStatusOptionsFromInput(input)),
    globalRuntimeLayer(),
    (value) => renderGlobalStatusResult(value, globalStatusFormatFromInput(input)),
  );
};

const runMetaGlobalDestroy = (argv: ReadonlyArray<string>): Promise<void> => {
  const input = compiledCommandInputFromArgv("meta:global:destroy", argv);
  return runCompiledCommand(
    globalDestroy(globalDestroyOptionsFromInput(input)),
    globalRuntimeLayer(),
    renderGlobalDestroyResult,
  );
};

const runMetaGlobalConfig = (argv: ReadonlyArray<string>): Promise<void> => {
  const input = compiledCommandInputFromArgv("meta:global:config", argv);
  return runCompiledCommand(globalConfig(), globalRuntimeLayer(), (value) =>
    renderGlobalConfigResult(value, globalConfigFormatFromInput(input)),
  );
};

const runMetaGlobalUninstall = (argv: ReadonlyArray<string>): Promise<void> => {
  const input = compiledCommandInputFromArgv("meta:global:uninstall", argv);
  return runCompiledCommand(
    globalUninstall(globalUninstallOptionsFromInput(input)),
    globalRuntimeLayer(),
    renderGlobalUninstallResult,
  );
};

const runMetaUninstall = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("meta:uninstall", argv)) return Promise.resolve();
  const input = compiledCommandInputFromArgv("meta:uninstall", argv);
  return runCompiledCommand(
    uninstall({
      ...uninstallOptionsFromInput(input),
      execPath: process.execPath,
    }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderUninstallResult,
  );
};

const runMetaGlobalInstall = (argv: ReadonlyArray<string>): Promise<void> => {
  const input = compiledCommandInputFromArgv("meta:global:install", argv);
  return runCompiledCommand(
    globalInstall(globalInstallOptionsFromInput(input)),
    globalRuntimeLayer(),
    renderGlobalInstallResult,
  );
};

const runMetaBun = async (argv: ReadonlyArray<string>): Promise<void> => {
  const exit = await Effect.runPromiseExit(
    metaBun({ argv: argv.slice() }).pipe(Effect.provide(makeRendererServiceLiveForMode(activeRendererMode))),
  );
  if (Exit.isSuccess(exit)) {
    if (exit.value.exitCode !== 0) process.exitCode = exit.value.exitCode;
    const rendered = renderMetaBunResult(exit.value);
    if (rendered !== undefined) emitResultLine(rendered);
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  emitDiagnosticLine(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

const runMetaX = async (argv: ReadonlyArray<string>): Promise<void> => {
  const [spec, ...rest] = argv;
  if (spec === undefined) {
    emitDiagnosticLine("meta:x requires a package spec as the first positional argument.");
    process.exitCode = 1;
    return;
  }
  const exit = await Effect.runPromiseExit(
    metaX({ spec, argv: rest }).pipe(Effect.provide(makeRendererServiceLiveForMode(activeRendererMode))),
  );
  if (Exit.isSuccess(exit)) {
    if (exit.value.exitCode !== 0) process.exitCode = exit.value.exitCode;
    const rendered = renderMetaXResult(exit.value);
    if (rendered !== undefined) emitResultLine(rendered);
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  emitDiagnosticLine(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

const runMetaPluginAdd = async (argv: ReadonlyArray<string>): Promise<void> => {
  const trust = argv.includes("--trust") || argv.includes("--yes") || argv.includes("-y");
  const spec = argv.find((arg) => !arg.startsWith("-"));
  if (spec === undefined) {
    emitDiagnosticLine(
      commandErrorMessage(
        new NotImplementedError({
          message: "meta:plugin:add requires a plugin spec argument.",
          commandId: "meta:plugin:add",
          remediation: "Pass an npm package spec, e.g. `lando plugin:add @lando/plugin-php`.",
        }),
      ),
    );
    process.exitCode = 1;
    return;
  }
  await runCompiledCommand(
    pluginAdd({ spec, trust, nonInteractive: process.stdin.isTTY !== true }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderPluginAddResult,
  );
};

const runMetaPluginRemove = async (argv: ReadonlyArray<string>): Promise<void> => {
  const name = argv.find((arg) => !arg.startsWith("-"));
  if (name === undefined) {
    emitDiagnosticLine(
      commandErrorMessage(
        new NotImplementedError({
          message: "meta:plugin:remove requires a plugin name argument.",
          commandId: "meta:plugin:remove",
          remediation: "Pass the plugin name, e.g. `lando plugin:remove @lando/plugin-php`.",
        }),
      ),
    );
    process.exitCode = 1;
    return;
  }
  await runCompiledCommand(
    pluginRemove({ name }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderPluginRemoveResult,
  );
};

const runMetaPluginTrust = async (argv: ReadonlyArray<string>): Promise<void> => {
  const action = argv.find((arg) => !arg.startsWith("-"));
  if (action === "list") {
    await runCompiledCommand(
      pluginTrustList(),
      makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
      renderPluginTrustListResult,
    );
    return;
  }
  if (action === "revoke") {
    const name = argv.slice(argv.indexOf(action) + 1).find((arg) => !arg.startsWith("-"));
    if (name === undefined) {
      emitDiagnosticLine(
        commandErrorMessage(
          new NotImplementedError({
            message: "meta:plugin:trust revoke requires a plugin name argument.",
            commandId: "meta:plugin:trust",
            remediation: "Pass the plugin name, e.g. `lando plugin:trust revoke @lando/plugin-php`.",
          }),
        ),
      );
      process.exitCode = 1;
      return;
    }
    await runCompiledCommand(
      pluginTrustRevoke({ name }),
      makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
      renderPluginTrustRevokeResult,
    );
    return;
  }
  const name = action;
  if (name === undefined) {
    emitDiagnosticLine(
      commandErrorMessage(
        new NotImplementedError({
          message: "meta:plugin:trust requires a plugin name argument.",
          commandId: "meta:plugin:trust",
          remediation: "Pass the plugin name, e.g. `lando plugin:trust @lando/plugin-php`.",
        }),
      ),
    );
    process.exitCode = 1;
    return;
  }
  await runCompiledCommand(
    pluginTrust({ name }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderPluginTrustResult,
  );
};

const runMetaPluginTrustAuthoringRoot = async (argv: ReadonlyArray<string>): Promise<void> => {
  const path = argv.find((arg) => !arg.startsWith("-"));
  if (path === undefined) {
    emitDiagnosticLine(
      commandErrorMessage(
        new NotImplementedError({
          message: "meta:plugin:trust-authoring-root requires an absolute path argument.",
          commandId: "meta:plugin:trust-authoring-root",
          remediation: "Pass an absolute path, e.g. `lando plugin:trust-authoring-root /home/me/plugin`.",
        }),
      ),
    );
    process.exitCode = 1;
    return;
  }
  await runCompiledCommand(
    pluginTrustAuthoringRoot({ path }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderPluginTrustAuthoringRootResult,
  );
};

const buildCanonicalCommandIdByToken = (): Readonly<Record<string, string>> => {
  const entries: Array<[string, string]> = [];
  for (const [id, command] of commandEntries) {
    const spec = (command as { readonly landoSpec?: { readonly id?: string } }).landoSpec;
    const canonicalId = spec?.id ?? id;
    entries.push([id, canonicalId]);
    for (const alias of command.aliases ?? []) entries.push([alias, canonicalId]);
  }
  for (const [id, command] of Object.entries(compiledManifest.commands)) {
    const spec = (command as { readonly landoSpec?: { readonly id?: string } }).landoSpec;
    const canonicalId = spec?.id ?? id;
    entries.push([id, canonicalId]);
    for (const alias of command.aliases ?? []) entries.push([alias, canonicalId]);
    for (const alias of command.aliasPermutations ?? []) entries.push([alias, canonicalId]);
    for (const permutation of command.permutations ?? []) entries.push([permutation, canonicalId]);
  }
  return Object.fromEntries(entries);
};

const CANONICAL_COMMAND_ID_BY_TOKEN = buildCanonicalCommandIdByToken();

const resolveCanonicalCommandId = (token: string | undefined): string => {
  if (token === undefined) return "cli:unknown";
  return CANONICAL_COMMAND_ID_BY_TOKEN[token] ?? token;
};

const runMetaVersion = async (): Promise<void> => {
  const result = await Effect.runPromise(versionOperation);
  emitResultLine(`@lando/core ${result.core} (bun ${result.bun} on ${result.platform})`);
};

const SHELLENV_SHELLS = ["posix", "powershell", "pwsh"] as const;

const runMetaShellenv = (argv: ReadonlyArray<string> = []): void => {
  if (rejectInvalidInvocation("meta:shellenv", argv)) return;
  const input = compiledCommandInputFromArgv("meta:shellenv", argv);
  const shell = input.flags.shell;
  if (argv.includes("--shell") && shell === undefined) {
    emitDiagnosticLine("Flag --shell expects one of these values: posix, powershell, pwsh");
    process.exitCode = 2;
    return;
  }
  if (shell !== undefined && !SHELLENV_SHELLS.includes(shell as (typeof SHELLENV_SHELLS)[number])) {
    emitDiagnosticLine(`Expected --shell=${shell} to be one of: posix, powershell, pwsh`);
    process.exitCode = 2;
    return;
  }
  emitResultLine(renderShellenv(shellenvShellFromInput(input)));
};

const runCompiledCli = async (rawArgv: ReadonlyArray<string>): Promise<void> => {
  const rawHead = rawArgv[0];
  const isBunOrXPassthrough =
    rawHead === "bun" || rawHead === "meta:bun" || rawHead === "x" || rawHead === "meta:x";

  let argv: ReadonlyArray<string> = rawArgv;
  if (!isBunOrXPassthrough) {
    try {
      const resolution = await resolveCliRendererMode({ argv: rawArgv, env: process.env });
      argv = resolution.remainingArgv;
      setActiveRendererMode(resolution.mode);
    } catch (error) {
      if (error instanceof RendererSelectionError || error instanceof NotImplementedError) {
        setActiveCommandId("cli:renderer-selection");
        emitDiagnosticLine(commandErrorMessage(error));
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    const deprecationWarnings = resolveCliDeprecationWarnings({ argv, env: process.env });
    argv = deprecationWarnings.remainingArgv;
    setActiveDeprecationWarnings(deprecationWarnings.enabled);
  }

  setActiveCommandId(resolveCanonicalCommandId(argv[0]));

  const head = argv[0];
  const isBunOrX = head === "bun" || head === "meta:bun" || head === "x" || head === "meta:x";

  if (!isBunOrX && (argv.length === 0 || argv.includes("--help") || argv.includes("-h"))) {
    const commandArg = argv.find((arg) => !arg.startsWith("-"));
    if (commandArg === undefined) {
      printRootHelp();
      return;
    }

    const found = findCommand(commandArg);
    if (found === undefined) {
      throw new Error(`Command ${commandArg} not found`);
    }

    printCommandHelp(found[0], found[1]);
    return;
  }

  if ((argv.includes("--version") || argv.includes("-v")) && !isBunOrX) {
    emitResultLine(`${version} ${process.platform}-${process.arch} node-${process.version}`);
    return;
  }

  if (argv[0] === "init" || argv[0] === "apps:init") {
    try {
      const input = compiledCommandInputFromArgv("apps:init", argv.slice(1));
      const result = await initApp(initOptionsFromInput(input));
      emitResultLine(`Created ${result.appName} at ${result.directory}`);
    } catch (error) {
      emitDiagnosticLine(commandErrorMessage(error, "apps:init"));
      process.exitCode = 1;
    }
    return;
  }

  if (argv[0] === "start" || argv[0] === "app:start") {
    await runStart();
    return;
  }

  if (argv[0] === "stop" || argv[0] === "app:stop") {
    await runStop();
    return;
  }

  if (argv[0] === "info" || argv[0] === "app:info") {
    await runInfo();
    return;
  }

  if (argv[0] === "destroy" || argv[0] === "app:destroy") {
    await runDestroy(argv.slice(1));
    return;
  }

  if (argv[0] === "restart" || argv[0] === "app:restart") {
    await runRestart();
    return;
  }

  if (argv[0] === "rebuild" || argv[0] === "app:rebuild") {
    await runRebuild();
    return;
  }

  if (argv[0] === "logs" || argv[0] === "app:logs") {
    await runLogs(argv.slice(1));
    return;
  }

  if (argv[0] === "app:config:lint") {
    await runAppConfigLint(argv.slice(1));
    return;
  }

  if (argv[0] === "app:config:translate") {
    await runAppConfigTranslate(argv.slice(1));
    return;
  }

  if (argv[0] === "app:includes:update") {
    await runAppIncludesUpdate(argv.slice(1));
    return;
  }

  if (argv[0] === "app:includes:verify") {
    await runAppIncludesVerify(argv.slice(1));
    return;
  }

  if (argv[0] === "app:config") {
    await runAppConfig(argv.slice(1));
    return;
  }

  if (argv[0] === "app:cache:refresh") {
    await runAppCacheRefresh();
    return;
  }

  if (argv[0] === "setup" || argv[0] === "meta:setup") {
    await runSetup(argv.slice(1));
    return;
  }

  if (argv[0] === "doctor" || argv[0] === "meta:doctor") {
    await runDoctor(argv.slice(1));
    return;
  }

  if (argv[0] === "exec" || argv[0] === "app:exec") {
    await runExec(argv.slice(1));
    return;
  }

  if (argv[0] === "ssh" || argv[0] === "app:ssh") {
    await runSsh(argv.slice(1));
    return;
  }

  if (argv[0] === "shell" || argv[0] === "app:shell") {
    await runWithProcessAbortSignal((signal) => runShell(argv.slice(1), { signal }));
    return;
  }

  if (argv[0] === "list" || argv[0] === "apps:list") {
    await runAppsList(argv.slice(1));
    return;
  }

  if (argv[0] === "poweroff" || argv[0] === "apps:poweroff") {
    await runAppsPoweroff(argv.slice(1));
    return;
  }

  if (argv[0] === "scratch" || argv[0] === "scratch:start" || argv[0] === "apps:scratch:start") {
    await runAppsScratchStart(argv.slice(1));
    return;
  }

  if (argv[0] === "scratch:stop" || argv[0] === "apps:scratch:stop") {
    await runAppsScratchStop(argv.slice(1));
    return;
  }

  if (argv[0] === "scratch:destroy" || argv[0] === "apps:scratch:destroy") {
    await runAppsScratchDestroy(argv.slice(1));
    return;
  }

  if (argv[0] === "scratch:list" || argv[0] === "apps:scratch:list") {
    await runAppsScratchList(argv.slice(1));
    return;
  }

  if (argv[0] === "scratch:info" || argv[0] === "apps:scratch:info") {
    await runAppsScratchInfo(argv.slice(1));
    return;
  }

  if (argv[0] === "scratch:logs" || argv[0] === "apps:scratch:logs") {
    await runAppsScratchLogs(argv.slice(1));
    return;
  }

  if (argv[0] === "scratch:gc" || argv[0] === "apps:scratch:gc") {
    await runAppsScratchGc(argv.slice(1));
    return;
  }

  if (argv[0] === "config" || argv[0] === "meta:config") {
    await runMetaConfig(argv.slice(1));
    return;
  }

  if (argv[0] === "meta:version") {
    await runMetaVersion();
    return;
  }

  if (argv[0] === "shellenv" || argv[0] === "meta:shellenv") {
    runMetaShellenv(argv.slice(1));
    return;
  }

  if (argv[0] === "uninstall" || argv[0] === "meta:uninstall") {
    await runMetaUninstall(argv.slice(1));
    return;
  }

  if (argv[0] === "update" || argv[0] === "meta:update") {
    if (rejectInvalidInvocation("meta:update", argv.slice(1))) return;
    await runCompiledCommand(
      update(),
      makeLandoRuntime(cliRuntimeOptions({ bootstrap: "plugins", plugins: { policy: "discovery" } })),
      () => undefined,
    );
    return;
  }

  if (argv[0] === "global:config" || argv[0] === "meta:global:config") {
    await runMetaGlobalConfig(argv.slice(1));
    return;
  }

  if (argv[0] === "global:destroy" || argv[0] === "meta:global:destroy") {
    await runMetaGlobalDestroy(argv.slice(1));
    return;
  }

  if (argv[0] === "global:install" || argv[0] === "meta:global:install") {
    await runMetaGlobalInstall(argv.slice(1));
    return;
  }

  if (argv[0] === "global:start" || argv[0] === "meta:global:start") {
    await runMetaGlobalStart(argv.slice(1));
    return;
  }

  if (argv[0] === "global:status" || argv[0] === "meta:global:status") {
    await runMetaGlobalStatus(argv.slice(1));
    return;
  }

  if (argv[0] === "global:stop" || argv[0] === "meta:global:stop") {
    await runMetaGlobalStop();
    return;
  }

  if (argv[0] === "global:uninstall" || argv[0] === "meta:global:uninstall") {
    await runMetaGlobalUninstall(argv.slice(1));
    return;
  }

  if (argv[0] === "bun" || argv[0] === "meta:bun") {
    await runMetaBun(argv.slice(1));
    return;
  }

  if (argv[0] === "x" || argv[0] === "meta:x") {
    await runMetaX(argv.slice(1));
    return;
  }

  if (argv[0] === "plugin:add" || argv[0] === "meta:plugin:add") {
    await runMetaPluginAdd(argv.slice(1));
    return;
  }

  if (argv[0] === "plugin:remove" || argv[0] === "meta:plugin:remove") {
    await runMetaPluginRemove(argv.slice(1));
    return;
  }

  if (argv[0] === "plugin:trust" || argv[0] === "meta:plugin:trust") {
    await runMetaPluginTrust(argv.slice(1));
    return;
  }

  if (argv[0] === "plugin:trust-authoring-root" || argv[0] === "meta:plugin:trust-authoring-root") {
    await runMetaPluginTrustAuthoringRoot(argv.slice(1));
    return;
  }

  const found = findCommand(argv[0] ?? "");
  if (found === undefined) {
    if (argv[0] !== undefined && !argv[0].includes(":")) {
      setActiveCommandId(`app:${argv[0]}`);
      await runDynamicTooling(argv);
      return;
    }
    throw new Error(`Command ${argv[0] ?? ""} not found`);
  }

  emitDiagnosticLine(commandErrorMessage(notImplementedErrorForCommand(found[0])));
  process.exitCode = 1;
};

export interface RunCliOptions {
  readonly argv: ReadonlyArray<string>;
  readonly rootUrl: string;
}

export const isCompiledCliEntryPath = (entryPath: string, execPath: string = process.execPath): boolean =>
  entryPath.includes("$bunfs") ||
  normalize(entryPath) === normalize(execPath) ||
  extname(entryPath) !== ".ts";

export const runCli = async (options: RunCliOptions): Promise<void> => {
  const entryPath = fileURLToPath(options.rootUrl);
  const args = options.argv as Array<string>;

  if (isCompiledCliEntryPath(entryPath)) {
    await runCompiledCli(options.argv);
    return;
  }

  const rawHead = args[0];
  const isBunOrXPassthrough =
    rawHead === "bun" || rawHead === "meta:bun" || rawHead === "x" || rawHead === "meta:x";
  if (!isBunOrXPassthrough) {
    try {
      const resolution = await resolveCliRendererMode({ argv: args, env: process.env });
      setActiveRendererMode(resolution.mode);
    } catch (error) {
      if (error instanceof RendererSelectionError || error instanceof NotImplementedError) {
        setActiveCommandId("cli:renderer-selection");
        emitDiagnosticLine(commandErrorMessage(error));
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  }

  await execute({
    dir: options.rootUrl,
    args,
  });
};
