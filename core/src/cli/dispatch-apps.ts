/**
 * Compiled-CLI dispatch for `apps:*` topic commands: init, list, poweroff, and
 * the scratch-app lifecycle.
 *
 * Holds the small scratch dispatch helpers (input assembly, runtime-layer
 * selection, abort-signal wiring) alongside the branch table. Returns `false`
 * when the argv does not belong to this topic so `runCompiledCli` can fall
 * through to the next topic dispatcher.
 */
import { Effect } from "effect";

import type { ScratchAppService } from "@lando/sdk/services";

import { cliRuntimeOptions } from "../runtime/cli-options.ts";
import { makeLandoRuntime } from "../runtime/layer.ts";
import type { RendererMode } from "./bug-report.ts";
import { initApp } from "./commands/init.ts";
import { listServices, renderAppsListResult } from "./commands/list.ts";
import { poweroff, renderPoweroffResult } from "./commands/poweroff.ts";
import {
  normalizeScratchRunArgvForParsing,
  parseScratchRunArgv,
  renderScratchRunResult,
  scratchRun,
  scratchRunSuccessExitCode,
} from "./commands/scratch-run.ts";
import {
  type ScratchStartOptions,
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
import { compiledCommandInputFromArgv } from "./compiled-input.ts";
import {
  type CompiledCommandInput,
  activeRendererMode,
  activeResultFormat,
  activeTableJsonFormat,
  emitDiagnosticLine,
  runCompiledCommand,
  runWithProcessAbortSignal,
  scratchRunRuntimeLayer,
  scratchRuntimeLayer,
} from "./compiled-runtime.ts";
import { initOptionsFromInput } from "./oclif/commands/apps/init.ts";
import { keepVolumesFromInput } from "./oclif/commands/apps/scratch/destroy.ts";
import { pruneFromInput } from "./oclif/commands/apps/scratch/gc.ts";
import type { RenderContext } from "./renderer-boundary.ts";

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

export const dispatchAppsCommand = async (argv: ReadonlyArray<string>): Promise<boolean> => {
  if (argv[0] === "init" || argv[0] === "apps:init") {
    const input = compiledCommandInputFromArgv("apps:init", argv.slice(1));
    await runCompiledCommand(
      Effect.tryPromise({
        try: () => initApp({ ...initOptionsFromInput(input), onWarn: emitDiagnosticLine }),
        catch: (error) => error,
      }),
      makeLandoRuntime(
        cliRuntimeOptions({
          bootstrap: "minimal",
          plugins: { policy: "discovery" },
        }),
      ),
      (result) => `Created ${result.appName} at ${result.directory}`,
    );
    return true;
  }

  if (argv[0] === "list" || argv[0] === "apps:list") {
    await runAppsList(argv.slice(1));
    return true;
  }

  if (argv[0] === "poweroff" || argv[0] === "apps:poweroff") {
    await runAppsPoweroff(argv.slice(1));
    return true;
  }

  if (argv[0] === "scratch" || argv[0] === "scratch:start" || argv[0] === "apps:scratch:start") {
    await runAppsScratchStart(argv.slice(1));
    return true;
  }

  if (argv[0] === "scratch:stop" || argv[0] === "apps:scratch:stop") {
    await runAppsScratchStop(argv.slice(1));
    return true;
  }

  if (argv[0] === "scratch:destroy" || argv[0] === "apps:scratch:destroy") {
    await runAppsScratchDestroy(argv.slice(1));
    return true;
  }

  if (argv[0] === "scratch:list" || argv[0] === "apps:scratch:list") {
    await runAppsScratchList(argv.slice(1));
    return true;
  }

  if (argv[0] === "scratch:info" || argv[0] === "apps:scratch:info") {
    await runAppsScratchInfo(argv.slice(1));
    return true;
  }

  if (argv[0] === "scratch:logs" || argv[0] === "apps:scratch:logs") {
    await runAppsScratchLogs(argv.slice(1));
    return true;
  }

  if (argv[0] === "scratch:gc" || argv[0] === "apps:scratch:gc") {
    await runAppsScratchGc(argv.slice(1));
    return true;
  }

  if (argv[0] === "run" || argv[0] === "scratch:run" || argv[0] === "apps:scratch:run") {
    await runAppsScratchRun(normalizeScratchRunArgvForParsing(argv.slice(1)));
    return true;
  }

  return false;
};
