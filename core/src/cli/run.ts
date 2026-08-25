import { Effect, Layer } from "effect";

import { LogLevelSelectionError, NotImplementedError, RendererSelectionError } from "@lando/sdk/errors";

import { readFreshAppCommandCacheForCwd } from "@lando/engine/cache/command-index-writer";
import { HOST_PROXY_WORKER_COMMAND } from "@lando/engine/subsystems/host-proxy/worker";
import {
  isReservedNamespaceHead,
  notImplementedErrorForCommand,
  resolveBuiltInCommand,
} from "./built-in-command-registry";
import { runMetaVersion } from "./cli-adapters/meta-plugin";
import { type HelpTopic, isHelpTopic, renderColdAllHelp, renderColdTopicHelp } from "./cold-path-output";
import type { ScratchStartOptions } from "./commands/scratch";
import { normalizeScratchStartArgv, scratchStartOptionsFromInput } from "./commands/scratch";
import { scratchRunHasCommandTail } from "./commands/scratch-run";
import { type CompiledCommand, findCommand, flagDefinitionsForCommand } from "./compiled-argv";
import {
  printCommandHelp,
  printHelpCatalogJson,
  printRootHelp,
  printToolingHelp,
  toolingHelpEntryForToken,
} from "./compiled-help";
import { compiledCommandInputFromArgv } from "./compiled-input";
import {
  normalizeCompiledCommandArgv,
  normalizeCompiledScratchRunArgvForUniversalFlags,
} from "./compiled-normalize";
import {
  activeRendererMode,
  activeResultFormat,
  commandErrorMessage,
  emitDiagnosticLine,
  emitResultLine,
  resetActiveCommandInvocation,
  runCompiledCommand,
  setActiveCommandId,
  setActiveDeprecationWarnings,
  setActiveRendererMode,
  setActiveResultFormat,
} from "./compiled-runtime";
import { renderAliasResolutionFailure, routeResolvedTooling } from "./dynamic-tooling";
import { validateCommandCliFlags } from "./flag-value-validation";
import { DEFAULT_RESULT_FORMAT, resolveResultFormat } from "./format-flags";
import { runHostProxyWorkerProcess } from "./host-proxy/worker-runtime";
import { resolveLogLevel } from "./log-level-selection";
import { runNativeOnlyBuiltIn } from "./native-only-built-in-adapters";
import { resolveCliDeprecationWarnings, resolveCliRendererMode } from "./renderer-boundary";
import { applyDebugRendererFlip, readConfigCliGlobals } from "./renderer-mode-resolution";
import { setActiveLogLevel } from "./renderer-mode-state";
import { runBuiltInCommand } from "./run-built-in-command";
import { tryPluginOwnedCommand } from "./run-plugin-owned-command";
import { preCommandOutputMode, renderPreCommandFailure } from "./spec/command-boundary";
import { resolveToolingRoute } from "./tooling-router";
import { unknownCommandError } from "./unknown-command-error";

export { normalizeCompiledCommandArgv } from "./compiled-normalize";
export { normalizeScratchRunArgvForParsing } from "./commands/scratch-run";
export { compiledCommandInputFromArgv };
export { renderCompiledDoctorReport } from "./cli-adapters/app-lifecycle";

export const parseScratchStartArgv = (argv: ReadonlyArray<string>): ScratchStartOptions =>
  scratchStartOptionsFromInput(compiledCommandInputFromArgv("apps:scratch:start", argv));

const failUnknownCommand = (token: string) =>
  renderPreCommandFailure({
    commandId: "cli:unknown-command",
    error: unknownCommandError(token),
    rendererMode: activeRendererMode,
    resultFormat: activeResultFormat,
  });

// allow: SIZE_OK — help dispatch stays in the single native dispatcher so source and compiled entries share one registry.
const HELP_SPECIAL_FLAGS = {
  all: { type: "boolean" },
  help: { type: "boolean", char: "h" },
} as const;

const readAppCommandCacheOrNull = async () => {
  const cache = await Effect.runPromise(Effect.either(readFreshAppCommandCacheForCwd()));
  return cache._tag === "Right" ? cache.right : null;
};

const printAllHelp = async (): Promise<void> => {
  const cache = await readAppCommandCacheOrNull();
  emitResultLine(
    renderColdAllHelp(cache?.aliasPolicy === undefined ? {} : { aliasPolicy: cache.aliasPolicy }),
  );
};

const printTopicHelp = async (topic: HelpTopic): Promise<void> => {
  const cache = await readAppCommandCacheOrNull();
  emitResultLine(
    renderColdTopicHelp(topic, cache?.aliasPolicy === undefined ? {} : { aliasPolicy: cache.aliasPolicy }),
  );
};

const rejectUnknownHelpFlags = async (argv: ReadonlyArray<string>): Promise<boolean> => {
  const flagError = validateCommandCliFlags({
    commandId: "cli:help",
    argv,
    definitions: HELP_SPECIAL_FLAGS,
    allowUnknownFlags: false,
  });
  if (flagError === undefined) return false;
  await runCompiledCommand(Effect.fail(flagError), Layer.empty, () => undefined, {
    failureExitCode: () => 2,
    preCommand: true,
  });
  return true;
};

const printRootHelpPage = async (): Promise<void> => {
  printRootHelp(undefined, await readAppCommandCacheOrNull());
};

const printHelpCatalogPage = async (): Promise<void> => {
  printHelpCatalogJson(await readAppCommandCacheOrNull());
};

const dispatchHelpTarget = async (token: string): Promise<void> => {
  if (isHelpTopic(token)) {
    await printTopicHelp(token);
    return;
  }
  const helpCommand = resolveBuiltInCommand(token);
  if (helpCommand !== undefined) {
    printCommandHelp(helpCommand);
    return;
  }
  const cache = await readAppCommandCacheOrNull();
  const tooling = cache === null ? undefined : toolingHelpEntryForToken(cache, token);
  if (tooling !== undefined) {
    printToolingHelp(tooling, cache?.aliasPolicy);
    return;
  }
  if (await tryPluginOwnedCommand(token, ["--help"])) return;
  await failUnknownCommand(token);
};

const runCompiledCli = async (rawArgv: ReadonlyArray<string>): Promise<void> => {
  if (rawArgv[0] === HOST_PROXY_WORKER_COMMAND) {
    setActiveLogLevel("none");
    await runHostProxyWorkerProcess();
    return;
  }

  const rawHead = rawArgv[0];
  const rawEntry = resolveBuiltInCommand(rawHead);
  const passthroughAliasResolution =
    rawHead !== undefined &&
    rawEntry?.spec.id !== rawHead &&
    !rawHead.startsWith("-") &&
    (rawEntry !== undefined || !isReservedNamespaceHead(rawHead))
      ? await Effect.runPromise(Effect.either(resolveToolingRoute(rawHead)))
      : undefined;
  const isBunOrXAlias =
    passthroughAliasResolution?._tag === "Right" &&
    passthroughAliasResolution.right._tag === "built-in" &&
    (passthroughAliasResolution.right.commandId === "meta:bun" ||
      passthroughAliasResolution.right.commandId === "meta:x");
  const isBunOrXPassthrough =
    rawHead === "meta:bun" ||
    rawHead === "meta:x" ||
    isBunOrXAlias ||
    ((rawHead === "bun" || rawHead === "x") &&
      passthroughAliasResolution?._tag === "Right" &&
      passthroughAliasResolution.right._tag === "not-tooling");

  let argv: ReadonlyArray<string> = rawArgv;
  if (!isBunOrXPassthrough) {
    argv = normalizeCompiledScratchRunArgvForUniversalFlags(normalizeCompiledCommandArgv(rawArgv));
    const isProtocolStdoutCommand =
      rawHead === "mcp" ||
      rawHead === "meta:mcp" ||
      (passthroughAliasResolution?._tag === "Right" &&
        passthroughAliasResolution.right._tag === "built-in" &&
        passthroughAliasResolution.right.commandId === "meta:mcp");
    try {
      const configGlobals = await readConfigCliGlobals();
      const logLevelResolution = resolveLogLevel({
        argv,
        env: process.env,
        ...(configGlobals.logLevel === undefined ? {} : { configValue: configGlobals.logLevel }),
      });
      argv = logLevelResolution.remainingArgv;
      setActiveLogLevel(logLevelResolution.level);

      const resolution = await resolveCliRendererMode({
        argv,
        env: process.env,
        loadConfigRenderer: async () => configGlobals.renderer,
      });
      argv = resolution.remainingArgv;
      const mode = isProtocolStdoutCommand
        ? resolution.mode
        : applyDebugRendererFlip({ level: logLevelResolution.level, renderer: resolution });
      setActiveRendererMode(mode);
    } catch (error) {
      if (
        error instanceof LogLevelSelectionError ||
        error instanceof RendererSelectionError ||
        error instanceof NotImplementedError
      ) {
        const commandId =
          error instanceof LogLevelSelectionError ? "cli:log-level-selection" : "cli:renderer-selection";
        setActiveCommandId(commandId);
        const output = preCommandOutputMode({ argv, env: process.env });
        await renderPreCommandFailure({
          commandId,
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

  if (argv[0] === "help") {
    const helpArgv = argv.slice(1);
    if (await rejectUnknownHelpFlags(helpArgv)) return;
    if (activeResultFormat === "json") {
      setActiveCommandId("cli:help");
      await printHelpCatalogPage();
      return;
    }
    if (helpArgv.includes("--all")) {
      await printAllHelp();
      return;
    }
    const target = helpArgv.find((arg) => !arg.startsWith("-"));
    if (target === undefined) {
      await printRootHelpPage();
      return;
    }
    await dispatchHelpTarget(target);
    return;
  }

  let builtInCommand = resolveBuiltInCommand(argv[0]);
  if (builtInCommand?.spec.id !== argv[0]) builtInCommand = undefined;
  if (
    builtInCommand === undefined &&
    (passthroughAliasResolution !== undefined || !isReservedNamespaceHead(argv[0]))
  ) {
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
      await failUnknownCommand(route.token);
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
  if (canonicalCommandId === "meta:mcp") {
    const flags = argv.slice(1);
    const terminator = flags.indexOf("--");
    const beforeTerminator = terminator === -1 ? flags : flags.slice(0, terminator);
    if (!beforeTerminator.includes("--list")) setActiveLogLevel("none");
  }

  const head = argv[0];
  const isBunOrX = head === "bun" || head === "meta:bun" || head === "x" || head === "meta:x";
  const isScratchRun = head === "run" || head === "scratch:run" || head === "apps:scratch:run";
  const scratchRunHasToolCommand = isScratchRun && scratchRunHasCommandTail(argv.slice(1));
  const dashDashIndex = argv.indexOf("--");
  const dispatchArgv = dashDashIndex === -1 ? argv : argv.slice(0, dashDashIndex);
  const passthroughHasPayload =
    isBunOrX && dispatchArgv.slice(1).some((arg) => arg !== "--help" && arg !== "-h");
  const found: [string, CompiledCommand] | undefined =
    builtInCommand === undefined ? findCommand(argv[0] ?? "") : [builtInCommand.spec.id, builtInCommand.spec];

  if (
    !passthroughHasPayload &&
    !scratchRunHasToolCommand &&
    (dispatchArgv.length === 0 || dispatchArgv.includes("--help") || dispatchArgv.includes("-h"))
  ) {
    const commandArg = dispatchArgv.find((arg) => !arg.startsWith("-"));
    if (commandArg === undefined) {
      if (dispatchArgv.includes("--all")) {
        if (await rejectUnknownHelpFlags(dispatchArgv)) return;
        await printAllHelp();
        return;
      }
      await printRootHelpPage();
      return;
    }

    await dispatchHelpTarget(commandArg);
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
    const token = argv[0] ?? "";
    if (await tryPluginOwnedCommand(token, argv.slice(1))) return;
    await failUnknownCommand(token);
    return;
  }

  if (builtInCommand?.status.kind === "embedding-exempt") {
    await runNativeOnlyBuiltIn(builtInCommand, argv.slice(1));
    return;
  }
  if (builtInCommand !== undefined) {
    await runBuiltInCommand(builtInCommand, argv.slice(1));
    return;
  }

  throw new TypeError(`Implemented command ${found[0]} has no catalog entry.`);
};

export interface RunCliOptions {
  readonly argv: ReadonlyArray<string>;
  readonly rootUrl: string;
}

export const runCli = (options: RunCliOptions): Promise<void> => runCompiledCli(options.argv);
