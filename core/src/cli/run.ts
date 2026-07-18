import { extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { execute } from "@oclif/core";
import { Effect, Layer } from "effect";

import { NotImplementedError, RendererSelectionError } from "@lando/sdk/errors";
import type { ScratchAppService } from "@lando/sdk/services";

import { cliRuntimeOptions } from "../runtime/cli-options.ts";
import { makeLandoRuntime } from "../runtime/layer.ts";
import { HOST_PROXY_WORKER_COMMAND, runHostProxyWorkerProcess } from "../subsystems/host-proxy/worker.ts";

import { CORE_VERSION } from "../version.ts";
import type { RendererMode } from "./bug-report.ts";
import { config, renderConfigResult } from "./commands/config.ts";

import { initApp } from "./commands/init.ts";
import { listServices, renderAppsListResult } from "./commands/list.ts";
import { poweroff, renderPoweroffResult } from "./commands/poweroff.ts";
import {
  parseScratchRunArgv,
  renderScratchRunResult,
  scratchRun,
  scratchRunHasCommandTail,
  scratchRunSuccessExitCode,
} from "./commands/scratch-run.ts";
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
import { update } from "./commands/update.ts";
import {
  normalizeCompiledCommandArgv,
  normalizeCompiledScratchRunArgvForUniversalFlags,
  normalizeScratchRunArgvForParsing,
} from "./compiled-normalize.ts";
export { normalizeCompiledCommandArgv };
export { normalizeScratchRunArgvForParsing } from "./commands/scratch-run.ts";
import { renderCommandHelpFlags, renderCommandUsage } from "./cli-help.ts";
import {
  type CompiledCommand,
  commandEntries,
  commandName,
  findCommand,
  flagDefinitionsForCommand,
} from "./compiled-argv.ts";
import { compiledCommandInputFromArgv } from "./compiled-input.ts";
import {
  type CompiledCommandInput,
  activeRendererMode,
  activeResultFormat,
  activeTableJsonFormat,
  commandErrorMessage,
  emitDiagnosticLine,
  emitResultLine,
  rejectInvalidInvocation,
  resetActiveCommandInvocation,
  runCompiledCommand,
  runWithProcessAbortSignal,
  scratchRunRuntimeLayer,
  scratchRuntimeLayer,
  setActiveCommandId,
  setActiveDeprecationWarnings,
  setActiveRendererMode,
  setActiveResultFormat,
} from "./compiled-runtime.ts";
export { compiledCommandInputFromArgv } from "./compiled-input.ts";
import { validateCommandCliFlags } from "./flag-value-validation.ts";
import { DEFAULT_RESULT_FORMAT, resolveResultFormat } from "./format-flags.ts";
import { notImplementedErrorForCommand } from "./oclif/command-base.ts";
import { preCommandOutputMode, renderPreCommandFailure } from "./oclif/command-boundary.ts";
import { initOptionsFromInput } from "./oclif/commands/apps/init.ts";
import { keepVolumesFromInput } from "./oclif/commands/apps/scratch/destroy.ts";
import { pruneFromInput } from "./oclif/commands/apps/scratch/gc.ts";
import { metaConfigOptionsFromInput } from "./oclif/commands/meta/config.ts";
import { updateOptionsFromInput } from "./oclif/commands/meta/update.ts";
import {
  type RenderContext,
  resolveCliDeprecationWarnings,
  resolveCliRendererMode,
} from "./renderer-boundary.ts";

const version = `@lando/core/${CORE_VERSION}`;

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
  const lines = [
    `${command.description ?? command.summary ?? id}

USAGE
  $ lando ${renderCommandUsage(id, command)}

ALIASES
  ${[id, ...(command.aliases ?? [])].join(", ")}`,
  ];
  lines.push(...renderCommandHelpFlags(command));
  emitResultLine(lines.join("\n"));
};

import {
  routeDynamicTooling,
  runAppCacheRefresh,
  runAppConfig,
  runAppConfigLint,
  runAppConfigTranslate,
  runAppConfigVerb,
  runAppIncludesUpdate,
  runAppIncludesVerify,
  runDestroy,
  runDoctor,
  runInfo,
  runLogs,
  runOpen,
  runPull,
  runPush,
  runRebuild,
  runRemoteAdd,
  runRemoteEnvList,
  runRemoteList,
  runRemoteRemove,
  runRemoteSetup,
  runRemoteTest,
  runRestart,
  runSetup,
  runShare,
  runShareList,
  runShareStop,
  runStart,
  runStop,
} from "./cli-adapters/app-lifecycle.ts";

export { renderCompiledDoctorReport } from "./cli-adapters/app-lifecycle.ts";
import { runExec, runShell, runSsh } from "./cli-adapters/exec-shell.ts";
import {
  resolveCanonicalCommandId,
  runMetaBun,
  runMetaGlobalConfig,
  runMetaGlobalConfigVerb,
  runMetaGlobalDestroy,
  runMetaGlobalInfo,
  runMetaGlobalInstall,
  runMetaGlobalList,
  runMetaGlobalLogs,
  runMetaGlobalRebuild,
  runMetaGlobalRestart,
  runMetaGlobalStart,
  runMetaGlobalStatus,
  runMetaGlobalStop,
  runMetaGlobalUninstall,
  runMetaMcp,
  runMetaPluginAdd,
  runMetaPluginBuild,
  runMetaPluginLink,
  runMetaPluginNew,
  runMetaPluginPublish,
  runMetaPluginRemove,
  runMetaPluginTest,
  runMetaPluginTrust,
  runMetaPluginTrustAuthoringRoot,
  runMetaPluginUnlink,
  runMetaRecipesDescribe,
  runMetaRecipesList,
  runMetaRecipesValidate,
  runMetaShellenv,
  runMetaUninstall,
  runMetaVersion,
  runMetaX,
} from "./cli-adapters/meta-plugin.ts";

const runAppsList = async (_argv: ReadonlyArray<string>): Promise<void> => {
  const format = activeTableJsonFormat();
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
  const input = compiledCommandInputFromArgv("meta:config", argv);
  const options = metaConfigOptionsFromInput(input);
  return runCompiledCommand(
    config(options),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderConfigResult,
  );
};

const runScratchEffect = <A>(
  operation: Effect.Effect<A, unknown, ScratchAppService>,
  render: (result: A, ctx: RenderContext) => string | undefined,
): Promise<void> => runCompiledCommand(operation, scratchRuntimeLayer(), render);

export const parseScratchStartArgv = (argv: ReadonlyArray<string>): ScratchStartOptions =>
  scratchStartOptionsFromInput(compiledCommandInputFromArgv("apps:scratch:start", argv));

const scratchCommandInput = (
  commandId: string,
  argv: ReadonlyArray<string>,
  options: { readonly rendererMode?: RendererMode; readonly signal?: AbortSignal } = {},
): CompiledCommandInput =>
  compiledCommandInputFromArgv(commandId, argv, {
    rendererMode: activeRendererMode,
    resultFormat: activeResultFormat,
    ...options,
  });

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
  await runScratchEffect(scratchList(), (result, ctx) =>
    renderScratchListResult(result, scratchListFormatFromInput(input), ctx),
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

const runAppsScratchRun = (argv: ReadonlyArray<string>): Promise<void> =>
  runWithProcessAbortSignal((signal) =>
    runCompiledCommand(
      scratchRun({ ...parseScratchRunArgv(argv), signal }),
      scratchRunRuntimeLayer(),
      renderScratchRunResult,
      { successExitCode: scratchRunSuccessExitCode },
    ),
  );

const runCompiledCli = async (rawArgv: ReadonlyArray<string>): Promise<void> => {
  if (rawArgv[0] === HOST_PROXY_WORKER_COMMAND) {
    await runHostProxyWorkerProcess();
    return;
  }

  const rawHead = rawArgv[0];
  const isBunOrXPassthrough =
    rawHead === "bun" || rawHead === "meta:bun" || rawHead === "x" || rawHead === "meta:x";

  let argv: ReadonlyArray<string> = rawArgv;
  if (!isBunOrXPassthrough) {
    argv = normalizeCompiledScratchRunArgvForUniversalFlags(normalizeCompiledCommandArgv(rawArgv));
    try {
      const resolution = await resolveCliRendererMode({ argv, env: process.env });
      argv = resolution.remainingArgv;
      setActiveRendererMode(resolution.mode);
    } catch (error) {
      if (error instanceof RendererSelectionError || error instanceof NotImplementedError) {
        setActiveCommandId("cli:renderer-selection");
        const output = preCommandOutputMode({ argv, env: process.env });
        await renderPreCommandFailure({
          commandId: "cli:renderer-selection",
          error,
          ...output,
        });
        return;
      }
      throw error;
    }
    const deprecationWarnings = resolveCliDeprecationWarnings({ argv, env: process.env });
    argv = deprecationWarnings.remainingArgv;
    setActiveDeprecationWarnings(deprecationWarnings.enabled);
    try {
      const formatResolution = resolveResultFormat({ argv, rendererMode: activeRendererMode });
      argv = formatResolution.remainingArgv;
      setActiveResultFormat(formatResolution.format);
    } catch (error) {
      if (error instanceof RendererSelectionError) {
        setActiveCommandId("cli:format-selection");
        await renderPreCommandFailure({
          commandId: "cli:format-selection",
          error,
          rendererMode: activeRendererMode,
          resultFormat: activeRendererMode === "json" ? "json" : "text",
        });
        return;
      }
      throw error;
    }
  } else {
    setActiveResultFormat(DEFAULT_RESULT_FORMAT);
  }

  argv = normalizeCompiledCommandArgv(argv);

  const canonicalCommandId = resolveCanonicalCommandId(argv[0]);
  if (canonicalCommandId === "apps:scratch:start" && argv[0] !== undefined) {
    argv = [argv[0], ...normalizeScratchStartArgv(argv.slice(1))];
  }
  setActiveCommandId(canonicalCommandId);
  resetActiveCommandInvocation(canonicalCommandId, argv.slice(1));

  const head = argv[0];
  const isBunOrX = head === "bun" || head === "meta:bun" || head === "x" || head === "meta:x";
  const isScratchRun = head === "run" || head === "scratch:run" || head === "apps:scratch:run";
  const scratchRunHasToolCommand = isScratchRun && scratchRunHasCommandTail(argv.slice(1));
  const dashDashIndex = argv.indexOf("--");
  const dispatchArgv = dashDashIndex === -1 ? argv : argv.slice(0, dashDashIndex);
  const found = findCommand(argv[0] ?? "");

  if (found === undefined && (await routeDynamicTooling(argv))) return;

  if (
    !isBunOrX &&
    !scratchRunHasToolCommand &&
    (dispatchArgv.length === 0 || dispatchArgv.includes("--help") || dispatchArgv.includes("-h"))
  ) {
    const commandArg = dispatchArgv.find((arg) => !arg.startsWith("-"));
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
    (dispatchArgv.includes("--version") || dispatchArgv.includes("-v")) &&
    !isBunOrX &&
    !scratchRunHasToolCommand
  ) {
    await runMetaVersion();
    return;
  }

  if (found !== undefined) {
    const flagError = validateCommandCliFlags({
      commandId: canonicalCommandId,
      argv: argv.slice(1),
      definitions: flagDefinitionsForCommand(found[1]),
      allowUnknownFlags: isBunOrX || found[1].strict === false,
    });
    if (flagError !== undefined) {
      await runCompiledCommand(Effect.fail(flagError), Layer.empty, () => undefined, {
        failureExitCode: () => 2,
        preCommand: true,
      });
      return;
    }
  }

  if (argv[0] === "init" || argv[0] === "apps:init") {
    const input = compiledCommandInputFromArgv("apps:init", argv.slice(1));
    await runCompiledCommand(
      Effect.tryPromise({
        try: () => initApp({ ...initOptionsFromInput(input), onWarn: emitDiagnosticLine }),
        catch: (error) => error,
      }),
      Layer.empty,
      (result) => `Created ${result.appName} at ${result.directory}`,
    );
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
    await runInfo(argv.slice(1));
    return;
  }

  if (argv[0] === "open" || argv[0] === "app:open") {
    await runOpen(argv.slice(1));
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

  if (argv[0] === "pull" || argv[0] === "app:pull" || argv[0] === "pull:app") {
    await runPull(argv.slice(1));
    return;
  }

  if (argv[0] === "push" || argv[0] === "app:push" || argv[0] === "push:app") {
    await runPush(argv.slice(1));
    return;
  }

  if (argv[0] === "share" || argv[0] === "app:share" || argv[0] === "share:app") {
    await runShare(argv.slice(1));
    return;
  }

  if (
    argv[0] === "app:share:list" ||
    argv[0] === "share:app:list" ||
    argv[0] === "share:list:app" ||
    argv[0] === "app:list:share" ||
    argv[0] === "list:app:share" ||
    argv[0] === "list:share:app"
  ) {
    await runShareList(argv.slice(1));
    return;
  }

  if (
    argv[0] === "app:share:stop" ||
    argv[0] === "share:app:stop" ||
    argv[0] === "share:stop:app" ||
    argv[0] === "app:stop:share" ||
    argv[0] === "stop:app:share" ||
    argv[0] === "stop:share:app"
  ) {
    await runShareStop(argv.slice(1));
    return;
  }

  if (
    argv[0] === "app:remote:list" ||
    argv[0] === "remote:app:list" ||
    argv[0] === "remote:list:app" ||
    argv[0] === "app:list:remote" ||
    argv[0] === "list:app:remote" ||
    argv[0] === "list:remote:app"
  ) {
    await runRemoteList(argv.slice(1));
    return;
  }

  if (
    argv[0] === "app:remote:add" ||
    argv[0] === "remote:app:add" ||
    argv[0] === "remote:add:app" ||
    argv[0] === "app:add:remote" ||
    argv[0] === "add:app:remote" ||
    argv[0] === "add:remote:app"
  ) {
    await runRemoteAdd(argv.slice(1));
    return;
  }

  if (
    argv[0] === "app:remote:remove" ||
    argv[0] === "remote:app:remove" ||
    argv[0] === "remote:remove:app" ||
    argv[0] === "app:remove:remote" ||
    argv[0] === "remove:app:remote" ||
    argv[0] === "remove:remote:app"
  ) {
    await runRemoteRemove(argv.slice(1));
    return;
  }

  if (
    argv[0] === "app:remote:test" ||
    argv[0] === "remote:app:test" ||
    argv[0] === "remote:test:app" ||
    argv[0] === "app:test:remote" ||
    argv[0] === "test:app:remote" ||
    argv[0] === "test:remote:app"
  ) {
    await runRemoteTest(argv.slice(1));
    return;
  }

  if (
    argv[0] === "app:remote:setup" ||
    argv[0] === "remote:app:setup" ||
    argv[0] === "remote:setup:app" ||
    argv[0] === "app:setup:remote" ||
    argv[0] === "setup:app:remote" ||
    argv[0] === "setup:remote:app"
  ) {
    await runRemoteSetup(argv.slice(1));
    return;
  }

  if (
    argv[0] === "app:remote:env:list" ||
    argv[0] === "app:env:remote:list" ||
    argv[0] === "env:app:remote:list" ||
    argv[0] === "env:remote:app:list" ||
    argv[0] === "env:remote:list:app" ||
    argv[0] === "app:remote:list:env" ||
    argv[0] === "remote:app:env:list" ||
    argv[0] === "remote:env:app:list" ||
    argv[0] === "remote:env:list:app" ||
    argv[0] === "remote:list:app:env" ||
    argv[0] === "remote:list:env:app"
  ) {
    await runRemoteEnvList(argv.slice(1));
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

  if (argv[0] === "app:config:set") {
    await runAppConfigVerb("set", argv.slice(1));
    return;
  }

  if (argv[0] === "app:config:unset") {
    await runAppConfigVerb("unset", argv.slice(1));
    return;
  }

  if (argv[0] === "app:config:edit") {
    await runAppConfigVerb("edit", argv.slice(1));
    return;
  }

  if (argv[0] === "app:config:validate") {
    await runAppConfigVerb("validate", argv.slice(1));
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

  if (argv[0] === "run" || argv[0] === "scratch:run" || argv[0] === "apps:scratch:run") {
    await runAppsScratchRun(normalizeScratchRunArgvForParsing(argv.slice(1)));
    return;
  }

  if (argv[0] === "config" || argv[0] === "meta:config") {
    await runMetaConfig(argv.slice(1));
    return;
  }

  if (argv[0] === "version" || argv[0] === "meta:version") {
    await runMetaVersion();
    return;
  }

  if (argv[0] === "recipes" || argv[0] === "meta:recipes:list") {
    if (rejectInvalidInvocation("meta:recipes:list", argv.slice(1))) return;
    await runMetaRecipesList();
    return;
  }

  if (argv[0] === "meta:recipes:describe") {
    await runMetaRecipesDescribe(argv.slice(1));
    return;
  }

  if (argv[0] === "meta:recipes:validate") {
    await runMetaRecipesValidate(argv.slice(1));
    return;
  }

  if (argv[0] === "shellenv" || argv[0] === "meta:shellenv") {
    await runMetaShellenv(argv.slice(1));
    return;
  }

  if (argv[0] === "uninstall" || argv[0] === "meta:uninstall") {
    await runMetaUninstall(argv.slice(1));
    return;
  }

  if (argv[0] === "mcp" || argv[0] === "meta:mcp") {
    await runMetaMcp(argv.slice(1));
    return;
  }

  if (argv[0] === "update" || argv[0] === "meta:update") {
    if (rejectInvalidInvocation("meta:update", argv.slice(1))) return;
    const input = compiledCommandInputFromArgv("meta:update", argv.slice(1));
    await runCompiledCommand(
      update(updateOptionsFromInput(input)),
      makeLandoRuntime(cliRuntimeOptions({ bootstrap: "commands", plugins: { policy: "discovery" } })),
      () => undefined,
    );
    return;
  }

  if (argv[0] === "global:config:set" || argv[0] === "meta:global:config:set") {
    await runMetaGlobalConfigVerb("set", argv.slice(1));
    return;
  }

  if (argv[0] === "global:config:unset" || argv[0] === "meta:global:config:unset") {
    await runMetaGlobalConfigVerb("unset", argv.slice(1));
    return;
  }

  if (argv[0] === "global:config:edit" || argv[0] === "meta:global:config:edit") {
    await runMetaGlobalConfigVerb("edit", argv.slice(1));
    return;
  }

  if (argv[0] === "global:config:validate" || argv[0] === "meta:global:config:validate") {
    await runMetaGlobalConfigVerb("validate", argv.slice(1));
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

  if (argv[0] === "global:info" || argv[0] === "meta:global:info") {
    await runMetaGlobalInfo(argv.slice(1));
    return;
  }

  if (argv[0] === "global:list" || argv[0] === "meta:global:list") {
    await runMetaGlobalList();
    return;
  }

  if (argv[0] === "global:logs" || argv[0] === "meta:global:logs") {
    await runMetaGlobalLogs(argv.slice(1));
    return;
  }

  if (argv[0] === "global:rebuild" || argv[0] === "meta:global:rebuild") {
    await runMetaGlobalRebuild(argv.slice(1));
    return;
  }

  if (argv[0] === "global:restart" || argv[0] === "meta:global:restart") {
    await runMetaGlobalRestart();
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

  if (argv[0] === "meta:plugin:new") {
    await runMetaPluginNew(argv.slice(1));
    return;
  }

  if (argv[0] === "meta:plugin:test") {
    await runMetaPluginTest(argv.slice(1));
    return;
  }

  if (argv[0] === "meta:plugin:build") {
    await runMetaPluginBuild(argv.slice(1));
    return;
  }

  if (argv[0] === "meta:plugin:publish") {
    await runMetaPluginPublish(argv.slice(1));
    return;
  }

  if (argv[0] === "meta:plugin:link") {
    await runMetaPluginLink(argv.slice(1));
    return;
  }

  if (argv[0] === "meta:plugin:unlink") {
    await runMetaPluginUnlink(argv.slice(1));
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

  if (found === undefined) {
    throw new Error(`Command ${argv[0] ?? ""} not found`);
  }

  const error = notImplementedErrorForCommand(found[0]);
  if (activeResultFormat === "json") {
    setActiveCommandId(found[0]);
    await runCompiledCommand(Effect.fail(error), Layer.empty, () => undefined);
    return;
  }
  emitDiagnosticLine(commandErrorMessage(error));
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

  if (args[0] === HOST_PROXY_WORKER_COMMAND) {
    await runHostProxyWorkerProcess();
    return;
  }

  if (isCompiledCliEntryPath(entryPath)) {
    await runCompiledCli(options.argv);
    return;
  }

  const normalizedSourceArgv = normalizeCompiledCommandArgv(args);
  if (
    normalizedSourceArgv[0] === "run" ||
    normalizedSourceArgv[0] === "scratch:run" ||
    normalizedSourceArgv[0] === "apps:scratch:run"
  ) {
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
        const output = preCommandOutputMode({ argv: args, env: process.env });
        await renderPreCommandFailure({
          commandId: "cli:renderer-selection",
          error,
          ...output,
        });
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
