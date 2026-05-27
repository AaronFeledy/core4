import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { execute } from "@oclif/core";
import type { Command } from "@oclif/core";
import { Cause, Effect, Exit } from "effect";

import { NotImplementedError, RendererSelectionError } from "@lando/sdk/errors";

import { parseAnswerFlags } from "../recipes/prompts/index.ts";
import { makeLandoRuntime } from "../runtime/layer.ts";
import { type BugReportContext, type RendererMode, formatBugReport } from "./bug-report.ts";
import { refreshAppCache, renderAppCacheRefreshResult } from "./commands/app-cache-refresh.ts";
import { appConfig, renderAppConfigResult } from "./commands/app-config.ts";
import { metaBun, metaX, renderMetaBunResult, renderMetaXResult } from "./commands/bun.ts";
import { config, renderConfigResult } from "./commands/config.ts";
import { destroyApp, renderDestroyAppResult } from "./commands/destroy.ts";
import { doctor, renderDoctorResult } from "./commands/doctor.ts";
import { execApp, renderExecAppResult } from "./commands/exec.ts";
import { infoApp, renderInfoAppResult } from "./commands/info.ts";
import { initApp } from "./commands/init.ts";
import { listServices, renderAppsListResult } from "./commands/list.ts";
import { logsApp, renderLogsAppResult } from "./commands/logs.ts";
import { pluginAdd, renderPluginAddResult } from "./commands/plugin-add.ts";
import { pluginRemove, renderPluginRemoveResult } from "./commands/plugin-remove.ts";
import { poweroff, renderPoweroffResult } from "./commands/poweroff.ts";
import { rebuildApp, renderRebuildAppResult } from "./commands/rebuild.ts";
import { renderRestartAppResult, restartApp } from "./commands/restart.ts";
import { renderShellAppResult, shellApp } from "./commands/shell.ts";
import { renderStartAppResult, startApp } from "./commands/start.ts";
import { renderStopAppResult, stopApp } from "./commands/stop.ts";
import { notImplementedErrorForCommand } from "./oclif/command-base.ts";
import { setupSpec } from "./oclif/commands/meta/setup.ts";
import compiledCommands from "./oclif/compiled-commands.ts";
import { resolveRendererMode } from "./renderer-selection.ts";

const version = "@lando/core/0.0.0";

type CompiledCommand = Command.Class;

const commandEntries: Array<[string, CompiledCommand]> = Object.entries(compiledCommands).sort(
  ([left], [right]) => left.localeCompare(right),
);

const commandName = (id: string, command: CompiledCommand): string => {
  const aliases = command.aliases;
  if (!aliases || aliases.length === 0) return id;
  const nonFlagAlias = aliases.find((alias) => !alias.startsWith("-"));
  if (nonFlagAlias !== undefined) return nonFlagAlias;
  return aliases[0] ?? id;
};

const findCommand = (name: string): [string, CompiledCommand] | undefined =>
  commandEntries.find(([id, command]) => id === name || command.aliases?.includes(name));

const printRootHelp = (): void => {
  console.log(`Lando v4 core: runtime, planner, OCLIF adapter, and library API.

VERSION
  ${version} ${process.platform}-${process.arch} node-${process.version}

USAGE
  $ lando [COMMAND]

TOPICS
  app   Operate on the current Lando app.
  apps  Discover and operate across Lando apps on the host.
  meta  Operate on Lando itself: config, plugins, host setup.

COMMANDS`);
  for (const [id, command] of commandEntries) {
    const name = commandName(id, command);
    if (!name.includes(":")) {
      console.log(`  ${name.padEnd(22)} ${command.description ?? ""}`);
    }
  }
};

const printCommandHelp = (id: string, command: CompiledCommand): void => {
  console.log(`${command.description ?? command.summary ?? id}

USAGE
  $ lando ${commandName(id, command)}

ALIASES
  ${[id, ...(command.aliases ?? [])].join(", ")}`);
};

let activeRendererMode: RendererMode = "lando";
let activeCommandId = "cli:unknown";

const setActiveRendererMode = (mode: RendererMode): void => {
  activeRendererMode = mode;
};

const setActiveCommandId = (commandId: string): void => {
  activeCommandId = commandId;
};

const commandErrorMessage = (error: unknown, commandId: string = activeCommandId): string => {
  const context: BugReportContext = { commandId };
  return formatBugReport({ error, context, rendererMode: activeRendererMode });
};

const runStart = async (): Promise<void> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const exit = await Effect.runPromiseExit(
      startApp({ signal: controller.signal }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
    );
    if (Exit.isSuccess(exit)) {
      console.log(renderStartAppResult(exit.value));
      return;
    }
    const failure = Cause.failureOption(exit.cause);
    console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
};

const runStop = async (): Promise<void> => {
  const exit = await Effect.runPromiseExit(
    stopApp().pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
  );
  if (Exit.isSuccess(exit)) {
    console.log(renderStopAppResult(exit.value));
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

const runInfo = async (): Promise<void> => {
  const exit = await Effect.runPromiseExit(
    infoApp().pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
  );
  if (Exit.isSuccess(exit)) {
    console.log(renderInfoAppResult(exit.value));
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

const runDestroy = async (argv: ReadonlyArray<string>): Promise<void> => {
  const volumes = argv.includes("--volumes");
  const yes = argv.includes("--yes") || argv.includes("-y");
  const exit = await Effect.runPromiseExit(
    destroyApp({ volumes, yes }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
  );
  if (Exit.isSuccess(exit)) {
    console.log(renderDestroyAppResult(exit.value));
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

const parseProviderFlag = (argv: ReadonlyArray<string>): string | undefined => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg.startsWith("--provider=")) return arg.slice("--provider=".length);
    if (arg === "--provider") return argv[index + 1];
  }
  return undefined;
};

const runSetup = async (argv: ReadonlyArray<string>): Promise<void> => {
  const installDir = dirname(process.execPath);
  const provider = parseProviderFlag(argv);
  const exit = await Effect.runPromiseExit(
    setupSpec
      .run({ installDir, flags: provider === undefined ? {} : { provider } })
      .pipe(Effect.provide(makeLandoRuntime({ bootstrap: "provider" }))),
  );
  if (Exit.isSuccess(exit)) {
    const rendered = setupSpec.render?.(exit.value);
    if (rendered !== undefined) console.log(rendered);
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  const message = failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause);
  if (activeRendererMode === "json") {
    console.error(message);
  } else {
    console.error(`${message}\nLANDO_INSTALL_DIR="${installDir}"`);
  }
  process.exitCode = 1;
};

const runRestart = async (): Promise<void> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const exit = await Effect.runPromiseExit(
      restartApp({ signal: controller.signal }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
    );
    if (Exit.isSuccess(exit)) {
      console.log(renderRestartAppResult(exit.value));
      return;
    }
    const failure = Cause.failureOption(exit.cause);
    console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
};

const runRebuild = async (): Promise<void> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const exit = await Effect.runPromiseExit(
      rebuildApp({ signal: controller.signal }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
    );
    if (Exit.isSuccess(exit)) {
      console.log(renderRebuildAppResult(exit.value));
      return;
    }
    const failure = Cause.failureOption(exit.cause);
    console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
};

const parseLogsArgv = (
  argv: ReadonlyArray<string>,
): {
  readonly service?: string;
  readonly follow: boolean;
  readonly tail?: number;
  readonly since?: string;
} => {
  let service: string | undefined;
  let follow = false;
  let tail: number | undefined;
  let since: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    const serviceMatch = parseStringFlag(argv, i, "service", "s");
    if (serviceMatch !== undefined) {
      service = serviceMatch.value;
      i += serviceMatch.consumed;
      continue;
    }
    const tailMatch = parseStringFlag(argv, i, "tail");
    if (tailMatch !== undefined) {
      const parsed = Number.parseInt(tailMatch.value, 10);
      if (!Number.isNaN(parsed)) tail = parsed;
      i += tailMatch.consumed;
      continue;
    }
    const sinceMatch = parseStringFlag(argv, i, "since");
    if (sinceMatch !== undefined) {
      since = sinceMatch.value;
      i += sinceMatch.consumed;
      continue;
    }
    if (arg === "--follow" || arg === "-f") {
      follow = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return {
    ...(service === undefined ? {} : { service }),
    follow,
    ...(tail === undefined ? {} : { tail }),
    ...(since === undefined ? {} : { since }),
  };
};

const runLogs = async (argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parseLogsArgv(argv);
  if (parsed.follow) {
    console.error(
      commandErrorMessage(
        new NotImplementedError({
          message:
            "`lando logs --follow` streaming output is deferred to Beta. Alpha returns a finite snapshot via `--tail`.",
          commandId: "app:logs",
          specSection: "spec/08-cli-and-tooling.md",
          remediation: "Drop --follow and rely on --tail <N> for a finite log snapshot.",
        }),
      ),
    );
    process.exitCode = 1;
    return;
  }
  if (parsed.since !== undefined) {
    console.error(
      commandErrorMessage(
        new NotImplementedError({
          message:
            "`lando logs --since` is deferred to Beta (provider LogOptions does not yet expose a since cursor).",
          commandId: "app:logs",
          specSection: "spec/08-cli-and-tooling.md",
          remediation: "Drop --since and use --tail <N> for a finite recent snapshot.",
        }),
      ),
    );
    process.exitCode = 1;
    return;
  }
  const exit = await Effect.runPromiseExit(
    logsApp({
      ...(parsed.service === undefined ? {} : { service: parsed.service }),
      ...(parsed.tail === undefined ? {} : { tail: parsed.tail }),
    }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
  );
  if (Exit.isSuccess(exit)) {
    console.log(renderLogsAppResult(exit.value));
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
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

const runAppConfig = async (argv: ReadonlyArray<string>): Promise<void> => {
  const { format } = parseAppConfigArgv(argv);
  const exit = await Effect.runPromiseExit(
    appConfig().pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
  );
  if (Exit.isSuccess(exit)) {
    console.log(renderAppConfigResult(exit.value, format));
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

const runAppCacheRefresh = async (): Promise<void> => {
  const exit = await Effect.runPromiseExit(
    refreshAppCache().pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
  );
  if (Exit.isSuccess(exit)) {
    console.log(renderAppCacheRefreshResult(exit.value));
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

const runDoctor = async (): Promise<void> => {
  const exit = await Effect.runPromiseExit(
    doctor().pipe(Effect.provide(makeLandoRuntime({ bootstrap: "provider" }))),
  );
  if (Exit.isSuccess(exit)) {
    console.log(renderDoctorResult(exit.value));
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
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

const runExec = async (argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parseExecArgv(argv);
  const exit = await Effect.runPromiseExit(
    execApp({
      command: parsed.command,
      ...(parsed.service === undefined ? {} : { service: parsed.service }),
      ...(parsed.user === undefined ? {} : { user: parsed.user }),
      ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
    }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
  );
  if (Exit.isSuccess(exit)) {
    const rendered = renderExecAppResult(exit.value);
    if (rendered !== undefined) console.log(rendered);
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
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
      specSection: "spec/08-cli-and-tooling.md",
      remediation:
        "Drop the unsupported flag. Alpha `lando ssh` runs the default service shell (`sh -l`) inside the selected service via provider-exec. SSH sidecar/subsystem support lands in Beta.",
    }),
  );

const runSsh = async (argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parseSshArgv(argv);
  if (parsed.subsystem !== undefined) {
    console.error(sshDeferred("subsystem"));
    process.exitCode = 1;
    return;
  }
  if (parsed.sidecar) {
    console.error(sshDeferred("sidecar"));
    process.exitCode = 1;
    return;
  }
  const command = parsed.command.length === 0 ? ["sh", "-l"] : parsed.command;
  const exit = await Effect.runPromiseExit(
    execApp({
      command,
      interactive: true,
      tty: true,
      ...(parsed.service === undefined ? {} : { service: parsed.service }),
      ...(parsed.user === undefined ? {} : { user: parsed.user }),
    }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
  );
  if (Exit.isSuccess(exit)) {
    const rendered = renderExecAppResult(exit.value);
    if (rendered !== undefined) console.log(rendered);
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

const parseShellService = (argv: ReadonlyArray<string>): string | undefined => {
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    const match = parseStringFlag(argv, i, "service", "s");
    if (match !== undefined) return match.value;
    i += 1;
  }
  return undefined;
};

const runShell = async (argv: ReadonlyArray<string>): Promise<void> => {
  const service = parseShellService(argv);
  const exit = await Effect.runPromiseExit(
    shellApp({
      ...(service === undefined ? {} : { service }),
    }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
  );
  if (Exit.isSuccess(exit)) {
    const rendered = renderShellAppResult(exit.value);
    if (rendered !== undefined) console.log(rendered);
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
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
  const exit = await Effect.runPromiseExit(
    listServices().pipe(Effect.provide(makeLandoRuntime({ bootstrap: "minimal" }))),
  );
  if (Exit.isSuccess(exit)) {
    console.log(renderAppsListResult(exit.value, format));
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

const runAppsPoweroff = async (argv: ReadonlyArray<string>): Promise<void> => {
  const keepGlobal = argv.includes("--keep-global");
  const keepScratch = argv.includes("--keep-scratch");
  const yes = argv.includes("--yes") || argv.includes("-y");
  const exit = await Effect.runPromiseExit(
    poweroff({ keepGlobal, keepScratch, yes }).pipe(
      Effect.provide(makeLandoRuntime({ bootstrap: "minimal" })),
    ),
  );
  if (Exit.isSuccess(exit)) {
    console.log(renderPoweroffResult(exit.value));
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
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
  const exit = await Effect.runPromiseExit(
    config({
      ...(subcommand === "get" || subcommand === "view" ? { subcommand } : {}),
      ...(key === undefined ? {} : { key }),
      ...(path === undefined ? {} : { path }),
      format,
    } as Parameters<typeof config>[0]).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "minimal" }))),
  );
  if (Exit.isSuccess(exit)) {
    console.log(renderConfigResult(exit.value));
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

const runMetaBun = async (argv: ReadonlyArray<string>): Promise<void> => {
  const exit = await Effect.runPromiseExit(metaBun({ argv: argv.slice() }));
  if (Exit.isSuccess(exit)) {
    if (exit.value.exitCode !== 0) process.exitCode = exit.value.exitCode;
    const rendered = renderMetaBunResult(exit.value);
    if (rendered !== undefined) console.log(rendered);
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

const runMetaX = async (argv: ReadonlyArray<string>): Promise<void> => {
  const [spec, ...rest] = argv;
  if (spec === undefined) {
    console.error("meta:x requires a package spec as the first positional argument.");
    process.exitCode = 1;
    return;
  }
  const exit = await Effect.runPromiseExit(metaX({ spec, argv: rest }));
  if (Exit.isSuccess(exit)) {
    if (exit.value.exitCode !== 0) process.exitCode = exit.value.exitCode;
    const rendered = renderMetaXResult(exit.value);
    if (rendered !== undefined) console.log(rendered);
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

const runMetaPluginAdd = async (argv: ReadonlyArray<string>): Promise<void> => {
  const trust = argv.includes("--trust") || argv.includes("--yes") || argv.includes("-y");
  const spec = argv.find((arg) => !arg.startsWith("-"));
  if (spec === undefined) {
    console.error(
      commandErrorMessage(
        new NotImplementedError({
          message: "meta:plugin:add requires a plugin spec argument.",
          commandId: "meta:plugin:add",
          specSection: "spec/10-plugins.md",
          remediation: "Pass an npm package spec, e.g. `lando plugin:add @lando/plugin-php`.",
        }),
      ),
    );
    process.exitCode = 1;
    return;
  }
  const exit = await Effect.runPromiseExit(
    pluginAdd({ spec, trust, nonInteractive: process.stdin.isTTY !== true }).pipe(
      Effect.provide(makeLandoRuntime({ bootstrap: "minimal" })),
    ),
  );
  if (Exit.isSuccess(exit)) {
    console.log(renderPluginAddResult(exit.value));
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

const runMetaPluginRemove = async (argv: ReadonlyArray<string>): Promise<void> => {
  const name = argv.find((arg) => !arg.startsWith("-"));
  if (name === undefined) {
    console.error(
      commandErrorMessage(
        new NotImplementedError({
          message: "meta:plugin:remove requires a plugin name argument.",
          commandId: "meta:plugin:remove",
          specSection: "spec/10-plugins.md",
          remediation: "Pass the plugin name, e.g. `lando plugin:remove @lando/plugin-php`.",
        }),
      ),
    );
    process.exitCode = 1;
    return;
  }
  const exit = await Effect.runPromiseExit(
    pluginRemove({ name }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "minimal" }))),
  );
  if (Exit.isSuccess(exit)) {
    console.log(renderPluginRemoveResult(exit.value));
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

const CANONICAL_COMMAND_ID_BY_TOKEN: Readonly<Record<string, string>> = {
  init: "apps:init",
  "apps:init": "apps:init",
  start: "app:start",
  "app:start": "app:start",
  stop: "app:stop",
  "app:stop": "app:stop",
  info: "app:info",
  "app:info": "app:info",
  destroy: "app:destroy",
  "app:destroy": "app:destroy",
  restart: "app:restart",
  "app:restart": "app:restart",
  rebuild: "app:rebuild",
  "app:rebuild": "app:rebuild",
  logs: "app:logs",
  "app:logs": "app:logs",
  "app:config": "app:config",
  "app:cache:refresh": "app:cache:refresh",
  setup: "meta:setup",
  "meta:setup": "meta:setup",
  doctor: "meta:doctor",
  "meta:doctor": "meta:doctor",
  exec: "app:exec",
  "app:exec": "app:exec",
  ssh: "app:ssh",
  "app:ssh": "app:ssh",
  shell: "app:shell",
  "app:shell": "app:shell",
  list: "apps:list",
  "apps:list": "apps:list",
  poweroff: "apps:poweroff",
  "apps:poweroff": "apps:poweroff",
  config: "meta:config",
  "meta:config": "meta:config",
  bun: "meta:bun",
  "meta:bun": "meta:bun",
  x: "meta:x",
  "meta:x": "meta:x",
  "plugin:add": "meta:plugin:add",
  "meta:plugin:add": "meta:plugin:add",
  "plugin:remove": "meta:plugin:remove",
  "meta:plugin:remove": "meta:plugin:remove",
  shellenv: "meta:shellenv",
  "meta:shellenv": "meta:shellenv",
  version: "meta:version",
  "meta:version": "meta:version",
};

const resolveCanonicalCommandId = (token: string | undefined): string => {
  if (token === undefined) return "cli:unknown";
  return CANONICAL_COMMAND_ID_BY_TOKEN[token] ?? token;
};

const runCompiledCli = async (rawArgv: ReadonlyArray<string>): Promise<void> => {
  const rawHead = rawArgv[0];
  const isBunOrXPassthrough =
    rawHead === "bun" || rawHead === "meta:bun" || rawHead === "x" || rawHead === "meta:x";

  let argv: ReadonlyArray<string> = rawArgv;
  if (!isBunOrXPassthrough) {
    try {
      const resolution = resolveRendererMode({ argv: rawArgv, env: process.env });
      argv = resolution.remainingArgv;
      setActiveRendererMode(resolution.mode);
    } catch (error) {
      if (error instanceof RendererSelectionError || error instanceof NotImplementedError) {
        setActiveCommandId("cli:renderer-selection");
        console.error(commandErrorMessage(error));
        process.exitCode = 1;
        return;
      }
      throw error;
    }
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

  if (
    (argv.includes("--version") || argv.includes("-v")) &&
    argv[0] !== "bun" &&
    argv[0] !== "meta:bun" &&
    argv[0] !== "x" &&
    argv[0] !== "meta:x"
  ) {
    console.log(`${version} ${process.platform}-${process.arch} node-${process.version}`);
    return;
  }

  if (argv[0] === "init" || argv[0] === "apps:init") {
    const rest = argv.slice(1);
    let name: string | undefined;
    let recipe: string | undefined;
    const answerValues: string[] = [];
    let full = false;
    let yes = false;
    let nonInteractive = false;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (arg === undefined) continue;
      if (arg === "--full") {
        full = true;
        continue;
      }
      if (arg === "--yes" || arg === "-y") {
        yes = true;
        continue;
      }
      if (arg === "--no-interactive" || arg === "--non-interactive") {
        nonInteractive = true;
        continue;
      }
      const nameMatch = parseStringFlag(rest, i, "name");
      if (nameMatch !== undefined) {
        name = nameMatch.value;
        i += nameMatch.consumed - 1;
        continue;
      }
      const recipeMatch = parseStringFlag(rest, i, "recipe");
      if (recipeMatch !== undefined) {
        recipe = recipeMatch.value;
        i += recipeMatch.consumed - 1;
        continue;
      }
      const answerMatch = parseStringFlag(rest, i, "answer");
      if (answerMatch !== undefined) {
        answerValues.push(answerMatch.value);
        i += answerMatch.consumed - 1;
      }
    }
    const answers = parseAnswerFlags(answerValues);
    try {
      const result = await initApp({
        cwd: process.cwd(),
        full,
        ...(name === undefined ? {} : { name }),
        ...(recipe === undefined ? {} : { recipe }),
        answers,
        yes,
        nonInteractive,
      });
      console.log(`Created ${result.appName} at ${result.directory}`);
    } catch (error) {
      console.error(commandErrorMessage(error, "apps:init"));
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
    await runDoctor();
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
    await runShell(argv.slice(1));
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

  if (argv[0] === "config" || argv[0] === "meta:config") {
    await runMetaConfig(argv.slice(1));
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

  const found = findCommand(argv[0] ?? "");
  if (found === undefined) {
    throw new Error(`Command ${argv[0] ?? ""} not found`);
  }

  console.error(commandErrorMessage(notImplementedErrorForCommand(found[0])));
  process.exitCode = 1;
};

export interface RunCliOptions {
  readonly argv: ReadonlyArray<string>;
  readonly rootUrl: string;
}

export const runCli = async (options: RunCliOptions): Promise<void> => {
  const entryPath = fileURLToPath(options.rootUrl);
  const args = options.argv as Array<string>;

  if (entryPath.includes("$bunfs")) {
    await runCompiledCli(options.argv);
    return;
  }

  const rawHead = args[0];
  const isBunOrXPassthrough =
    rawHead === "bun" || rawHead === "meta:bun" || rawHead === "x" || rawHead === "meta:x";
  if (!isBunOrXPassthrough) {
    try {
      const resolution = resolveRendererMode({ argv: args, env: process.env });
      setActiveRendererMode(resolution.mode);
    } catch (error) {
      if (error instanceof RendererSelectionError || error instanceof NotImplementedError) {
        setActiveCommandId("cli:renderer-selection");
        console.error(commandErrorMessage(error));
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
