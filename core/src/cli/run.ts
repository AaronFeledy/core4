import { extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { execute } from "@oclif/core";
import { Effect, Layer } from "effect";

import { NotImplementedError, RendererSelectionError } from "@lando/sdk/errors";

import { HOST_PROXY_WORKER_COMMAND, runHostProxyWorkerProcess } from "../subsystems/host-proxy/worker.ts";
import { routeDynamicTooling } from "./cli-adapters/app-lifecycle.ts";
import { resolveCanonicalCommandId, runMetaVersion } from "./cli-adapters/meta-plugin.ts";
import { scratchRunHasCommandTail } from "./commands/scratch-run.ts";
import { normalizeScratchStartArgv } from "./commands/scratch.ts";
import { findCommand, flagDefinitionsForCommand } from "./compiled-argv.ts";
import { printCommandHelp, printRootHelp } from "./compiled-help.ts";
import {
  normalizeCompiledCommandArgv,
  normalizeCompiledScratchRunArgvForUniversalFlags,
} from "./compiled-normalize.ts";
import {
  activeRendererMode,
  activeResultFormat,
  commandErrorMessage,
  emitDiagnosticLine,
  resetActiveCommandInvocation,
  runCompiledCommand,
  setActiveCommandId,
  setActiveDeprecationWarnings,
  setActiveRendererMode,
  setActiveResultFormat,
} from "./compiled-runtime.ts";
import { dispatchAppCommand } from "./dispatch-app.ts";
import { dispatchAppsCommand } from "./dispatch-apps.ts";
import { dispatchMetaCommand } from "./dispatch-meta.ts";
import { validateCommandCliFlags } from "./flag-value-validation.ts";
import { DEFAULT_RESULT_FORMAT, resolveResultFormat } from "./format-flags.ts";
import { notImplementedErrorForCommand } from "./oclif/command-base.ts";
import { preCommandOutputMode, renderPreCommandFailure } from "./oclif/command-boundary.ts";
import { resolveCliDeprecationWarnings, resolveCliRendererMode } from "./renderer-boundary.ts";

export { normalizeCompiledCommandArgv } from "./compiled-normalize.ts";
export { normalizeScratchRunArgvForParsing } from "./commands/scratch-run.ts";
export { compiledCommandInputFromArgv } from "./compiled-input.ts";
export { renderCompiledDoctorReport } from "./cli-adapters/app-lifecycle.ts";
export { parseScratchStartArgv } from "./dispatch-apps.ts";

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

    const helpCommand = findCommand(commandArg);
    if (helpCommand === undefined) {
      throw new Error(`Command ${commandArg} not found`);
    }

    printCommandHelp(helpCommand[0], helpCommand[1]);
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

  if (await dispatchAppCommand(argv)) return;
  if (await dispatchAppsCommand(argv)) return;
  if (await dispatchMetaCommand(argv)) return;

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
