import { dirname } from "node:path";

import { Effect } from "effect";

import { cliRuntimeOptions } from "../../runtime/cli-options.ts";
import { makeLandoRuntime } from "../../runtime/layer.ts";
import { refreshAppCache, renderAppCacheRefreshResult } from "../commands/app-cache-refresh.ts";
import { appConfigLint, renderConfigLintResult } from "../commands/app-config-lint.ts";
import { appConfigTranslate, renderConfigTranslateResult } from "../commands/app-config-translate.ts";
import { appConfig, renderAppConfigResult } from "../commands/app-config.ts";
import {
  type AppIncludesUpdateFormat,
  appIncludesUpdate,
  renderIncludesUpdateResult,
} from "../commands/app-includes-update.ts";
import { appIncludesVerify, renderIncludesVerifyResult } from "../commands/app-includes-verify.ts";
import { destroyApp, renderDestroyAppResult } from "../commands/destroy.ts";
import {
  type DoctorReport,
  doctorReport,
  renderDoctorReport,
  renderDoctorReportAsNdjson,
  renderDoctorReportAsYaml,
} from "../commands/doctor-report.ts";
import { infoApp, renderInfoAppResult } from "../commands/info.ts";
import { followLogsApp, logsApp, renderLogsAppResult } from "../commands/logs.ts";
import { openApp, openOptionsFromInput, renderOpenAppResult } from "../commands/open.ts";
import { rebuildApp, renderRebuildAppResult } from "../commands/rebuild.ts";
import {
  appPull,
  appPush,
  appRemoteAdd,
  appRemoteEnvList,
  appRemoteList,
  appRemoteRemove,
  appRemoteSetup,
  appRemoteTest,
  renderRemoteEnvListResult,
  renderRemoteListResult,
  renderRemoteMutationResult,
  renderRemoteTestResult,
  renderSyncResult,
} from "../commands/remote.ts";
import { renderRestartAppResult, restartApp } from "../commands/restart.ts";
import {
  appShare,
  appShareList,
  appShareStop,
  renderShareListResult,
  renderShareResult,
  renderShareStopResult,
} from "../commands/share.ts";
import { renderStartAppResult, startApp } from "../commands/start.ts";
import { renderStopAppResult, stopApp } from "../commands/stop.ts";
import { renderRunToolingResult, runTooling } from "../commands/tooling.ts";
import { compiledCommandInputFromArgv } from "../compiled-input.ts";
import {
  activeDeprecationWarnings,
  activeRendererMode,
  activeResultFormat,
  activeTableJsonFormat,
  activeTextJsonFormat,
  activeTextJsonYamlFormat,
  appRuntimeLayer,
  commandErrorMessage,
  compiledFormat,
  emitDiagnosticLine,
  rejectInvalidInvocation,
  runCompiledCommand,
  runWithProcessAbortSignal,
} from "../compiled-runtime.ts";
import { appConfigOptionsFromInput } from "../oclif/commands/app/config/index.ts";
import { logsFollowFromInput, logsOptionsFromInput } from "../oclif/commands/app/logs.ts";
import {
  remoteAddOptionsFromInput,
  remoteEnvListOptionsFromInput,
  remoteListOptionsFromInput,
  remoteRemoveOptionsFromInput,
  remoteSetupOptionsFromInput,
  remoteSyncOptionsFromInput,
  remoteTestOptionsFromInput,
} from "../oclif/commands/app/remote/common.ts";
import {
  shareListOptionsFromInput,
  shareOptionsFromInput,
  shareStopOptionsFromInput,
} from "../oclif/commands/app/share/common.ts";
import { setupSpec } from "../oclif/commands/meta/setup.ts";
import { type RenderContext, runWithRendererHandling } from "../renderer-boundary.ts";

export const runStart = (): Promise<void> =>
  runWithProcessAbortSignal((signal) =>
    runCompiledCommand(
      startApp({ signal }),
      makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
      renderStartAppResult,
    ),
  );

export const runStop = (): Promise<void> =>
  runCompiledCommand(
    stopApp(),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    renderStopAppResult,
  );

export const runDynamicTooling = (argv: ReadonlyArray<string>): Promise<void> => {
  const name = argv[0];
  if (name === undefined) throw new Error("Missing tooling command name");
  return runCompiledCommand(
    runTooling({ name, args: argv.slice(1), renderProgress: true }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    renderRunToolingResult,
    { renderEvents: true, plainTaskEvents: "detail-only" },
  );
};

export const runInfo = (argv: ReadonlyArray<string>): Promise<void> =>
  runCompiledCommand(
    infoApp({ deep: argv.includes("--deep") }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    renderInfoAppResult,
  );

export const runOpen = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("app:open", argv)) return Promise.resolve();
  return runCompiledCommand(
    openApp(openOptionsFromInput(compiledCommandInputFromArgv("app:open", argv))),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    renderOpenAppResult,
  );
};

export const runDestroy = (argv: ReadonlyArray<string>): Promise<void> => {
  const volumes = argv.includes("--volumes") || argv.includes("--purge");
  const purgeCaches = argv.includes("--purge-caches");
  const yes = argv.includes("--yes") || argv.includes("-y");
  return runCompiledCommand(
    destroyApp({ volumes, purgeCaches, yes }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    renderDestroyAppResult,
  );
};

export const parseProviderFlag = (argv: ReadonlyArray<string>): string | undefined => {
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

export const parseFixFlag = (argv: ReadonlyArray<string>): boolean => argv.some((arg) => arg === "--fix");

export const runSetup = async (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("meta:setup", argv)) return;
  const installDir = dirname(process.execPath);
  const input = compiledCommandInputFromArgv("meta:setup", argv);
  const hostProxy = input.flags["host-proxy"];
  if (hostProxy !== undefined && hostProxy !== "auto" && hostProxy !== "none") {
    emitDiagnosticLine("Invalid --host-proxy value. Expected one of: auto, none.");
    process.exitCode = 2;
    return;
  }
  await runWithRendererHandling(
    setupSpec.run({
      installDir,
      flags: input.flags,
    }),
    {
      runtime: makeLandoRuntime(
        cliRuntimeOptions({ bootstrap: "provider", plugins: { policy: "discovery" } }),
      ),
      rendererMode: activeRendererMode,
      resultFormat: activeResultFormat,
      command: setupSpec.id,
      resultSchema: setupSpec.resultSchema,
      deprecationWarnings: activeDeprecationWarnings,
      renderEvents: process.stdout.isTTY === true,
      render: (value, ctx) => setupSpec.render?.(value, undefined, ctx),
      formatError: (error) => {
        const message = commandErrorMessage(error);
        return activeRendererMode === "json" ? message : `${message}\nLANDO_INSTALL_DIR="${installDir}"`;
      },
    },
  );
};

export const runRestart = (): Promise<void> =>
  runWithProcessAbortSignal((signal) =>
    runCompiledCommand(
      restartApp({ signal }),
      makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
      renderRestartAppResult,
    ),
  );

export const runRebuild = (): Promise<void> =>
  runWithProcessAbortSignal((signal) =>
    runCompiledCommand(
      rebuildApp({ signal }),
      makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
      renderRebuildAppResult,
    ),
  );

export const runLogs = (argv: ReadonlyArray<string>): Promise<void> => {
  const input = compiledCommandInputFromArgv("app:logs", argv);
  const options = logsOptionsFromInput(input);
  const runtime = makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } }));
  if (logsFollowFromInput(input)) {
    return runWithProcessAbortSignal((signal) =>
      runCompiledCommand(followLogsApp({ ...options, follow: true, signal }), runtime, renderLogsAppResult, {
        streamingMode: "live",
      }),
    );
  }
  return runCompiledCommand(logsApp(options), runtime, renderLogsAppResult);
};

export const runPull = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("app:pull", argv)) return Promise.resolve();
  const input = compiledCommandInputFromArgv("app:pull", argv);
  return runCompiledCommand(appPull(remoteSyncOptionsFromInput(input)), appRuntimeLayer(), (value, ctx) =>
    renderSyncResult(value, compiledFormat(input), ctx),
  );
};

export const runPush = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("app:push", argv)) return Promise.resolve();
  const input = compiledCommandInputFromArgv("app:push", argv);
  return runCompiledCommand(appPush(remoteSyncOptionsFromInput(input)), appRuntimeLayer(), (value, ctx) =>
    renderSyncResult(value, compiledFormat(input), ctx),
  );
};

export const runShare = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("app:share", argv)) return Promise.resolve();
  const input = compiledCommandInputFromArgv("app:share", argv);
  return runCompiledCommand(
    Effect.scoped(appShare(shareOptionsFromInput(input))),
    appRuntimeLayer(),
    (value, ctx) => renderShareResult(value, compiledFormat(input), ctx),
  );
};

export const runShareList = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("app:share:list", argv)) return Promise.resolve();
  const input = compiledCommandInputFromArgv("app:share:list", argv);
  const options = shareListOptionsFromInput(input);
  return runCompiledCommand(appShareList(options), appRuntimeLayer(), (value, ctx) =>
    renderShareListResult(value, options.format, ctx),
  );
};

export const runShareStop = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("app:share:stop", argv)) return Promise.resolve();
  const input = compiledCommandInputFromArgv("app:share:stop", argv);
  const options = shareStopOptionsFromInput(input);
  return runCompiledCommand(appShareStop(options), appRuntimeLayer(), (value, ctx) =>
    renderShareStopResult(value, options.format, ctx),
  );
};

export const runRemoteList = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("app:remote:list", argv)) return Promise.resolve();
  const input = compiledCommandInputFromArgv("app:remote:list", argv);
  const options = remoteListOptionsFromInput(input);
  return runCompiledCommand(appRemoteList(options), appRuntimeLayer(), (value, ctx) =>
    renderRemoteListResult(value, options.format, ctx),
  );
};

export const runRemoteAdd = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("app:remote:add", argv)) return Promise.resolve();
  const input = compiledCommandInputFromArgv("app:remote:add", argv);
  const options = remoteAddOptionsFromInput(input);
  return runCompiledCommand(appRemoteAdd(options), appRuntimeLayer(), (value, ctx) =>
    renderRemoteMutationResult(value, "added", options.format, ctx),
  );
};

export const runRemoteRemove = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("app:remote:remove", argv)) return Promise.resolve();
  const input = compiledCommandInputFromArgv("app:remote:remove", argv);
  const options = remoteRemoveOptionsFromInput(input);
  return runCompiledCommand(appRemoteRemove(options), appRuntimeLayer(), (value, ctx) =>
    renderRemoteMutationResult(value, "removed", options.format, ctx),
  );
};

export const runRemoteTest = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("app:remote:test", argv)) return Promise.resolve();
  const input = compiledCommandInputFromArgv("app:remote:test", argv);
  const options = remoteTestOptionsFromInput(input);
  return runCompiledCommand(appRemoteTest(options), appRuntimeLayer(), (value, ctx) =>
    renderRemoteTestResult(value, options.format, ctx),
  );
};

export const runRemoteSetup = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("app:remote:setup", argv)) return Promise.resolve();
  const input = compiledCommandInputFromArgv("app:remote:setup", argv);
  const options = remoteSetupOptionsFromInput(input);
  return runCompiledCommand(appRemoteSetup(options), appRuntimeLayer(), (value, ctx) =>
    renderRemoteTestResult(value, options.format, ctx),
  );
};

export const runRemoteEnvList = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("app:remote:env:list", argv)) return Promise.resolve();
  const input = compiledCommandInputFromArgv("app:remote:env:list", argv);
  const options = remoteEnvListOptionsFromInput(input);
  return runCompiledCommand(appRemoteEnvList(options), appRuntimeLayer(), (value, ctx) =>
    renderRemoteEnvListResult(value, options.format, ctx),
  );
};

export const runAppConfig = (argv: ReadonlyArray<string>): Promise<void> => {
  const input = compiledCommandInputFromArgv("app:config", argv);
  const options = appConfigOptionsFromInput(input);
  const format = options.format ?? activeTableJsonFormat();
  return runCompiledCommand(
    appConfig(options),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    (value) => renderAppConfigResult(value, format),
  );
};

export const runAppConfigVerb = (
  subcommand: "set" | "unset" | "edit" | "validate",
  argv: ReadonlyArray<string>,
): Promise<void> => {
  const input = compiledCommandInputFromArgv(`app:config:${subcommand}`, argv);
  const options = { ...appConfigOptionsFromInput(input), subcommand };
  const format = options.format ?? activeTableJsonFormat();
  return runCompiledCommand(
    appConfig(options),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    (value) => renderAppConfigResult(value, format),
  );
};

export const runAppConfigLint = (_argv: ReadonlyArray<string>): Promise<void> => {
  const format = activeTextJsonFormat();
  return runCompiledCommand(
    appConfigLint(),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    (value) => renderConfigLintResult(value, format),
  );
};

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

export const parseAppConfigTranslateArgv = (
  argv: ReadonlyArray<string>,
): {
  readonly write: boolean;
  readonly list: boolean;
  readonly detect: boolean;
  readonly from: string | undefined;
  readonly files: ReadonlyArray<string>;
} => {
  let write = false;
  let list = false;
  let detect = false;
  let from: string | undefined;
  const files: Array<string> = [];
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
    if (arg === "--list") {
      list = true;
      i += 1;
      continue;
    }
    if (arg === "--detect") {
      detect = true;
      i += 1;
      continue;
    }
    const fromMatch = parseStringFlag(argv, i, "from");
    if (fromMatch !== undefined) {
      from = fromMatch.value;
      i += fromMatch.consumed;
      continue;
    }
    const fileMatch = parseStringFlag(argv, i, "file");
    if (fileMatch !== undefined) {
      files.push(fileMatch.value);
      i += fileMatch.consumed;
      continue;
    }
    const formatMatch = parseStringFlag(argv, i, "format");
    if (formatMatch !== undefined) {
      i += formatMatch.consumed;
      continue;
    }
    i += 1;
  }
  return { write, list, detect, from, files };
};

export const runAppConfigTranslate = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("app:config:translate", argv)) return Promise.resolve();
  const { write, list, detect, from, files } = parseAppConfigTranslateArgv(argv);
  return runCompiledCommand(
    appConfigTranslate({
      write,
      list,
      detect,
      ...(from === undefined ? {} : { from }),
      ...(files.length === 0 ? {} : { files }),
    }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    (value) => renderConfigTranslateResult(value),
  );
};

export const parseAppIncludesUpdateArgv = (
  argv: ReadonlyArray<string>,
): {
  readonly check: boolean;
  readonly noNetwork: boolean;
  readonly sources: ReadonlyArray<string>;
  readonly format: AppIncludesUpdateFormat;
} => {
  const check = argv.some((arg) => arg === "--check");
  const noNetwork = argv.some((arg) => arg === "--no-network");
  const sources: string[] = [];
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
    const arg = argv[i];
    if (arg !== undefined && !arg.startsWith("-")) sources.push(arg);
    i += 1;
  }
  return { check, noNetwork, sources, format };
};

export const runAppIncludesUpdate = (argv: ReadonlyArray<string>): Promise<void> => {
  const { check, noNetwork, sources } = parseAppIncludesUpdateArgv(argv);
  const format = activeTextJsonFormat();
  return runCompiledCommand(
    appIncludesUpdate({ check, noNetwork, sources }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    (value) => renderIncludesUpdateResult(value, format),
    { successExitCode: (value) => (value.checkMode && value.drift ? 1 : undefined) },
  );
};

export const runAppIncludesVerify = (_argv: ReadonlyArray<string>): Promise<void> => {
  const format = activeTextJsonFormat();
  return runCompiledCommand(
    appIncludesVerify(),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    (value) => renderIncludesVerifyResult(value, format),
  );
};

export const runAppCacheRefresh = (): Promise<void> =>
  runCompiledCommand(
    refreshAppCache(),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    renderAppCacheRefreshResult,
  );

export const runDoctor = async (argv: ReadonlyArray<string>): Promise<void> => {
  const flagProvider = parseProviderFlag(argv);
  const fix = parseFixFlag(argv);
  const app = argv.some((arg) => arg === "--app");
  const deprecations = argv.some((arg) => arg === "--deprecations");
  const format = activeTextJsonYamlFormat();
  await runCompiledCommand(
    doctorReport({
      ...(flagProvider === undefined ? {} : { flagProviderId: flagProvider }),
      ...(fix ? { fix: true } : {}),
      ...(app ? { app: true } : {}),
      ...(deprecations ? { deprecations: true } : {}),
      format,
    }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "provider", plugins: { policy: "discovery" } })),
    renderCompiledDoctorReport,
    {
      suppressDeprecationDiagnostics: format === "json" || format === "yaml",
    },
  );
};

export const renderCompiledDoctorReport = (value: DoctorReport, ctx: RenderContext): string | undefined => {
  if (ctx.format === "ndjson") return renderDoctorReportAsNdjson(value);
  if (ctx.format === "yaml") return renderDoctorReportAsYaml(value);
  return renderDoctorReport(value, ctx);
};
