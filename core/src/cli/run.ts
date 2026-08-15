import { Effect, Layer } from "effect";

import { NotImplementedError, RendererSelectionError } from "@lando/sdk/errors";

import { HOST_PROXY_WORKER_COMMAND } from "@lando/engine/subsystems/host-proxy/worker";
import {
  isReservedNamespaceHead,
  notImplementedErrorForCommand,
  resolveBuiltInCommand,
} from "./built-in-command-registry";
import { runMetaVersion } from "./cli-adapters/meta-plugin";
import { normalizeScratchStartArgv } from "./commands/scratch";
import { scratchRunHasCommandTail } from "./commands/scratch-run";
import { type CompiledCommand, findCommand, flagDefinitionsForCommand } from "./compiled-argv";
import { printCommandHelp, printRootHelp } from "./compiled-help";
import {
  normalizeCompiledCommandArgv,
  normalizeCompiledScratchRunArgvForUniversalFlags,
} from "./compiled-normalize";
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
} from "./compiled-runtime";
import { dispatchAppCommand } from "./dispatch-app";
import { dispatchAppsCommand } from "./dispatch-apps";
import { dispatchMetaCommand } from "./dispatch-meta";
import { renderAliasResolutionFailure, routeResolvedTooling } from "./dynamic-tooling";
import { validateCommandCliFlags } from "./flag-value-validation";
import { DEFAULT_RESULT_FORMAT, resolveResultFormat } from "./format-flags";
import { runHostProxyWorkerProcess } from "./host-proxy/worker-runtime";
import { resolveCliDeprecationWarnings, resolveCliRendererMode } from "./renderer-boundary";
import { preCommandOutputMode, renderPreCommandFailure } from "./spec/command-boundary";
import { resolveAppCommandHelpAliases, resolveToolingRoute } from "./tooling-router";
import { unknownCommandError } from "./unknown-command-error";

export { normalizeCompiledCommandArgv } from "./compiled-normalize";
export { normalizeScratchRunArgvForParsing } from "./commands/scratch-run";
export { compiledCommandInputFromArgv } from "./compiled-input";
export { renderCompiledDoctorReport } from "./cli-adapters/app-lifecycle";
export { parseScratchStartArgv } from "./dispatch-apps";

const runCompiledCli = async (rawArgv: ReadonlyArray<string>): Promise<void> => {
  if (rawArgv[0] === HOST_PROXY_WORKER_COMMAND) {
    await runHostProxyWorkerProcess();
    return;
  }

  const rawHead = rawArgv[0];
  const rawEntry = resolveBuiltInCommand(rawHead);
  const passthroughAliasResolution =
    rawHead !== undefined &&
    rawEntry?.spec.id !== rawHead &&
    !rawHead.startsWith("-") &&
    !isReservedNamespaceHead(rawHead)
      ? await Effect.runPromise(Effect.either(resolveToolingRoute(rawHead)))
      : undefined;
  const passthroughAliasRoute =
    passthroughAliasResolution?._tag === "Right" &&
    passthroughAliasResolution.right._tag === "built-in" &&
    (passthroughAliasResolution.right.commandId === "meta:bun" ||
      passthroughAliasResolution.right.commandId === "meta:x")
      ? passthroughAliasResolution.right
      : undefined;
  const isBunOrXPassthrough =
    rawHead === "meta:bun" ||
    rawHead === "meta:x" ||
    passthroughAliasRoute !== undefined ||
    ((rawHead === "bun" || rawHead === "x") &&
      passthroughAliasResolution?._tag === "Right" &&
      passthroughAliasResolution.right._tag === "not-tooling");

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

  let builtInCommand = resolveBuiltInCommand(argv[0]);
  if (builtInCommand?.spec.id !== argv[0]) builtInCommand = undefined;
  if (builtInCommand === undefined && !isReservedNamespaceHead(argv[0])) {
    const argvTail = argv.slice(1);
    const aliasResolution =
      passthroughAliasResolution ?? (await Effect.runPromise(Effect.either(resolveToolingRoute(argv[0]))));
    if (aliasResolution._tag === "Left") {
      await renderAliasResolutionFailure(aliasResolution.left);
      return;
    }
    const route = aliasResolution.right;
    if (route._tag === "built-in") {
      builtInCommand = route.entry;
      argv = [route.commandId, ...argvTail];
    } else if (route._tag === "alias-disabled") {
      setActiveCommandId("cli:unknown-command");
      await renderPreCommandFailure({
        commandId: "cli:unknown-command",
        error: unknownCommandError(route.token),
        rendererMode: activeRendererMode,
        resultFormat: activeResultFormat,
      });
      return;
    } else if (await routeResolvedTooling(route, argvTail)) {
      return;
    }
    if (builtInCommand === undefined) builtInCommand = resolveBuiltInCommand(argv[0]);
  }
  const canonicalCommandId = builtInCommand?.spec.id ?? argv[0] ?? "cli:unknown";
  if (builtInCommand !== undefined) argv = [canonicalCommandId, ...argv.slice(1)];
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
  const passthroughHasPayload =
    isBunOrX && dispatchArgv.slice(1).some((arg) => arg !== "--help" && arg !== "-h");
  const found: [string, CompiledCommand] | undefined =
    builtInCommand === undefined
      ? findCommand(argv[0] ?? "")
      : [builtInCommand.spec.id, builtInCommand.command];

  if (
    !passthroughHasPayload &&
    !scratchRunHasToolCommand &&
    (dispatchArgv.length === 0 || dispatchArgv.includes("--help") || dispatchArgv.includes("-h"))
  ) {
    const commandArg = dispatchArgv.find((arg) => !arg.startsWith("-"));
    if (commandArg === undefined) {
      const helpAliases = await Effect.runPromise(Effect.either(resolveAppCommandHelpAliases()));
      if (helpAliases._tag === "Left") {
        await renderAliasResolutionFailure(helpAliases.left);
        return;
      }
      printRootHelp(helpAliases.right);
      return;
    }

    const helpCommand = resolveBuiltInCommand(commandArg);
    if (helpCommand === undefined) {
      await renderPreCommandFailure({
        commandId: "cli:unknown-command",
        error: unknownCommandError(commandArg),
        rendererMode: activeRendererMode,
        resultFormat: activeResultFormat,
      });
      return;
    }

    printCommandHelp(helpCommand);
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

  if (builtInCommand?.status.kind === "deferred") {
    const error = notImplementedErrorForCommand(builtInCommand.spec.id);
    if (activeResultFormat === "json") {
      await runCompiledCommand(Effect.fail(error), Layer.empty, () => undefined);
      return;
    }
    emitDiagnosticLine(commandErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  if (found === undefined) {
    await renderPreCommandFailure({
      commandId: "cli:unknown-command",
      error: unknownCommandError(argv[0] ?? ""),
      rendererMode: activeRendererMode,
      resultFormat: activeResultFormat,
    });
    return;
  }

  if (await dispatchAppCommand(argv)) return;
  if (await dispatchAppsCommand(argv)) return;
  if (await dispatchMetaCommand(argv)) return;

  throw new Error(`Implemented command ${found[0]} has no native dispatch adapter.`);
};

export interface RunCliOptions {
  readonly argv: ReadonlyArray<string>;
  readonly rootUrl: string;
}

export const runCli = async (options: RunCliOptions): Promise<void> => {
  await runCompiledCli(options.argv);
};
