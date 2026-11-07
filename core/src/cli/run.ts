import { type DiscoveryOperation, runDiscoveryOperation } from "@lando/landofile/operation-scope";
import { makeAppDiscoveryResolver } from "@lando/landofile/traversal-policy";
import { Cause, Effect, Exit, Layer } from "effect";

import {
  JsonJqConflictError,
  JsonProjectionError,
  LogLevelSelectionError,
  NotImplementedError,
  RendererSelectionError,
  ToolingInputError,
} from "@lando/sdk/errors";

import { HOST_PROXY_WORKER_COMMAND } from "@lando/engine/subsystems/host-proxy/worker";
import { AGENT_RELAY_WORKER_COMMAND } from "@lando/engine/subsystems/ssh-agent/worker-protocol";
import {
  CliInvocation,
  type CliInvocationContext,
  processInvocationContext,
} from "../runtime/invocation-context";
import {
  isReservedNamespaceHead,
  notImplementedErrorForCommand,
  resolveBuiltInCommand,
} from "./built-in-command-registry";
import { runMetaVersion } from "./cli-adapters/meta-plugin";
import { isHelpTopic } from "./cold-path-output";
import type { ScratchStartOptions } from "./commands/scratch";
import { normalizeScratchStartArgv, scratchStartOptionsFromInput } from "./commands/scratch";
import { scratchRunHasCommandTail } from "./commands/scratch-run";
import { type CompiledCommand, findCommand, flagDefinitionsForCommand } from "./compiled-argv";
import { COMPILED_DECODER_ASTS } from "./compiled-decoder-targets";
import { printToolingHelp } from "./compiled-help";
import { compiledCommandInputFromArgv } from "./compiled-input";
import {
  normalizeCompiledCommandArgv,
  normalizeCompiledScratchRunArgvForUniversalFlags,
} from "./compiled-normalize";
import {
  activeJq,
  activeJsonControl,
  activeRendererMode,
  activeResultFormat,
  commandErrorMessage,
  emitDiagnosticLine,
  emitJsonListModeIfRequested,
  resetActiveCommandInvocation,
  runCompiledCommand,
  setActiveCommandId,
  setActiveDeprecationWarnings,
  setActiveJq,
  setActiveJsonControl,
  setActiveRendererMode,
  setActiveResultFormat,
} from "./compiled-runtime";
import { renderAliasResolutionFailure, routeResolvedTooling } from "./dynamic-tooling";
import { validateCommandCliFlags } from "./flag-value-validation";
import {
  DEFAULT_RESULT_FORMAT,
  JSON_CONTROL_OFF,
  extractFormatFlags,
  isEnvelopeResultFormat,
  resolveJsonControl,
  resolveResultFormat,
} from "./format-flags";
import { install as installCompiledDecoders } from "./generated/compiled-decoders.mjs";
import { HOST_PROXY_RUNLANDO_ALLOWLIST } from "./generated/host-proxy-allowlist";
import { typeableName } from "./help-names";
import {
  HOST_PROXY_CALL_COMMAND,
  type HostProxyLandoCall,
  assertHostProxyAppContext,
  hostProxyCallCwd,
  hostProxyDenied,
} from "./host-proxy/call-context";
import { runHostProxyCallProcess } from "./host-proxy/call-runtime";
import { runHostProxyWorkerProcess } from "./host-proxy/worker-runtime";
import { interruptOnAbort } from "./interrupt-on-abort";
import { resolveLogLevel } from "./log-level-selection";
import { runNativeOnlyBuiltIn } from "./native-only-built-in-adapters";
import { type PluginCommandCatalog, createPluginCommandCatalog } from "./plugin-command-catalog";
import { resolveCliDeprecationWarnings, resolveCliRendererMode } from "./renderer-boundary";
import { applyDebugRendererFlip, readConfigCliGlobals } from "./renderer-mode-resolution";
import { setActiveLogLevel } from "./renderer-mode-state";
import { rejectUnsupportedResultFormat } from "./result-format-guard";
import { runBuiltInCommand } from "./run-built-in-command";
import {
  dispatchHelpTarget,
  printAllHelp,
  printHelpCatalogPage,
  printRootHelpPage,
  rejectUnknownHelpFlags,
} from "./run-help";
import { tryPluginOwnedCommand } from "./run-plugin-owned-command";
import { preCommandOutputMode, renderPreCommandFailure } from "./spec/command-boundary";
import {
  resolveToolingRoute,
  toolingHelpRequested,
  toolingRouteFailure,
  toolingVersionRequested,
} from "./tooling-router";
import { resolveTrace, setActiveTrace } from "./trace-selection";
import { unknownCommandError } from "./unknown-command-error";

export { normalizeCompiledCommandArgv } from "./compiled-normalize";
export { normalizeScratchRunArgvForParsing } from "./commands/scratch-run";
export { compiledCommandInputFromArgv };
export { renderCompiledDoctorReport } from "./cli-adapters/app-lifecycle";

export const parseScratchStartArgv = (argv: ReadonlyArray<string>): ScratchStartOptions =>
  scratchStartOptionsFromInput(compiledCommandInputFromArgv("apps:scratch:start", argv));

const failUnknownCommand = async (
  token: string,
  catalog: PluginCommandCatalog,
  suggestCanonicalId = true,
  context?: CliInvocationContext,
) =>
  renderPreCommandFailure({
    ...(context === undefined ? {} : { context }),
    commandId: "cli:unknown-command",
    error: unknownCommandError(
      token,
      suggestCanonicalId ? await catalog.unknownCommandRemediation(token) : undefined,
    ),
    rendererMode: activeRendererMode,
    resultFormat: activeResultFormat,
  });

const jsonControlConflict = (): JsonJqConflictError | JsonProjectionError | undefined => {
  if (activeJsonControl.mode === "list" && activeJq !== undefined) {
    return new JsonJqConflictError({
      message: "Cannot combine --jq with bare --json.",
      remediation: "cannot use --jq with bare --json; pass --json key1,key2 or omit --json",
    });
  }
  if (
    (activeJsonControl.mode === "keys" || activeJq !== undefined) &&
    !isEnvelopeResultFormat(activeResultFormat)
  ) {
    return new JsonProjectionError({
      message: "JSON projection requires an envelope format.",
      keys: activeJsonControl.mode === "keys" ? [...activeJsonControl.keys] : [],
      available: [],
      reason: "format_conflict",
      remediation: "Use --format=json or --format=yaml, or omit --format when projecting or using --jq.",
    });
  }
  return undefined;
};

const rejectJsonControlConflicts = async (context: CliInvocationContext): Promise<boolean> => {
  const error = jsonControlConflict();
  if (error === undefined) return false;
  setActiveCommandId("cli:json-control");
  await renderPreCommandFailure({
    context,
    commandId: "cli:json-control",
    error,
    rendererMode: activeRendererMode,
    resultFormat: "json",
    failureExitCode: 2,
  });
  return true;
};

const resolveToolingRouteExit = async (
  token: string | undefined,
  catalog: PluginCommandCatalog,
  options: { readonly signal?: AbortSignal; readonly rebuild: boolean; readonly rebuildNotice?: boolean },
  context: CliInvocationContext,
) => {
  const { signal, ...routeOptions } = options;
  const exit = await Effect.runPromiseExit(
    interruptOnAbort(Effect.result(resolveToolingRoute(token, { catalog, ...routeOptions })), signal).pipe(
      Effect.provideService(CliInvocation, context),
    ),
  );
  if (Exit.isFailure(exit)) throw exit.cause;
  return exit.value;
};

// Help and listing paths stay free of bundled plugin modules; command dispatch registers them before building a runtime.
const registerBundledPlugins = () => import("../runtime/bundled-plugins");

const runCompiledCli = async (
  rawArgv: ReadonlyArray<string>,
  signal?: AbortSignal,
  hostProxy?: HostProxyLandoCall,
  context: CliInvocationContext = processInvocationContext(),
): Promise<void> => {
  if (signal?.aborted) return;
  const catalog = createPluginCommandCatalog(signal, undefined, context);
  installCompiledDecoders(COMPILED_DECODER_ASTS);
  if (hostProxy !== undefined && rawArgv.some((arg) => arg.startsWith("__internal:")))
    throw hostProxyDenied("cli:internal");
  if (hostProxy === undefined && rawArgv[0] === HOST_PROXY_CALL_COMMAND) {
    await runHostProxyCallProcess(async (call, callSignal) => {
      switch (call.operation) {
        case "runLando":
          await runCli({ argv: call.argv, rootUrl: "", signal: callSignal, hostProxy: call, context });
          return;
        case "openUrl":
        case "openPath": {
          const { runHostProxyOpenProcess } = await import("./host-proxy/call-open");
          await runHostProxyOpenProcess(call, callSignal, context);
          return;
        }
        default: {
          const exhaustive: never = call;
          return exhaustive;
        }
      }
    }, context);
    return;
  }
  if (rawArgv[0] === AGENT_RELAY_WORKER_COMMAND) {
    setActiveLogLevel("none");
    const { runAgentRelayWorkerProcess } = await import("./agent-relay/worker-runtime");
    await runAgentRelayWorkerProcess({ context });
    return;
  }
  if (rawArgv[0] === HOST_PROXY_WORKER_COMMAND) {
    setActiveLogLevel("none");
    await runHostProxyWorkerProcess(context);
    return;
  }

  const rawHead = rawArgv[0];
  const rawEntry = resolveBuiltInCommand(rawHead);
  const passthroughAliasResolution =
    rawHead !== undefined &&
    rawEntry?.spec.id !== rawHead &&
    !rawHead.startsWith("-") &&
    (rawEntry !== undefined || !isReservedNamespaceHead(rawHead))
      ? await resolveToolingRouteExit(
          rawHead,
          catalog,
          {
            ...(signal === undefined ? {} : { signal }),
            // `lando help` rebuilds in its own dispatcher, so help for a built-in never rebuilds.
            rebuild: hostProxy === undefined && rawHead !== "help",
            // Output modes are not resolved yet; machine-output argv/env still silences the notice.
            rebuildNotice: preCommandOutputMode({ argv: rawArgv, env: context.env }).rendererMode !== "json",
          },
          context,
        )
      : undefined;
  const isBunOrXAlias =
    passthroughAliasResolution?._tag === "Success" &&
    passthroughAliasResolution.success._tag === "built-in" &&
    (passthroughAliasResolution.success.commandId === "meta:bun" ||
      passthroughAliasResolution.success.commandId === "meta:x");
  const isBunOrXPassthrough =
    rawHead === "meta:bun" ||
    rawHead === "meta:x" ||
    isBunOrXAlias ||
    ((rawHead === "bun" || rawHead === "x") &&
      passthroughAliasResolution?._tag === "Success" &&
      passthroughAliasResolution.success._tag === "not-tooling");

  let argv: ReadonlyArray<string> = rawArgv;
  setActiveTrace(undefined);
  if (!isBunOrXPassthrough) {
    argv = normalizeCompiledScratchRunArgvForUniversalFlags(normalizeCompiledCommandArgv(rawArgv));
    const isProtocolStdoutCommand =
      rawHead === "mcp" ||
      rawHead === "meta:mcp" ||
      (passthroughAliasResolution?._tag === "Success" &&
        passthroughAliasResolution.success._tag === "built-in" &&
        passthroughAliasResolution.success.commandId === "meta:mcp");
    try {
      const configGlobals = await readConfigCliGlobals(context.env);
      const trace = resolveTrace({
        argv,
        env: context.env,
        ...(configGlobals.tracing === undefined ? {} : { config: configGlobals.tracing }),
      });
      argv = trace.remainingArgv;
      setActiveTrace(trace);
      const logLevelResolution = resolveLogLevel({
        argv,
        env: context.env,
        ...(configGlobals.logLevel === undefined ? {} : { configValue: configGlobals.logLevel }),
      });
      argv = logLevelResolution.remainingArgv;
      setActiveLogLevel(logLevelResolution.level);

      const resolution = await resolveCliRendererMode({
        argv,
        env: context.env,
        loadConfigRenderer: async () => configGlobals.renderer,
      });
      argv = resolution.remainingArgv;
      const mode = isProtocolStdoutCommand
        ? resolution.mode
        : applyDebugRendererFlip({ verbose: logLevelResolution.verbose, renderer: resolution });
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
        const output = preCommandOutputMode({ argv, env: context.env });
        await renderPreCommandFailure({
          context,
          commandId,
          error,
          ...output,
        });
        return;
      }
      throw error;
    }
    const deprecationWarnings = resolveCliDeprecationWarnings({ argv, env: context.env });
    argv = deprecationWarnings.remainingArgv;
    setActiveDeprecationWarnings(deprecationWarnings.enabled);
    try {
      const extracted = extractFormatFlags(argv);
      const formatResolution = resolveResultFormat({ argv, rendererMode: activeRendererMode });
      argv = formatResolution.remainingArgv;
      setActiveResultFormat(formatResolution.format);
      // Bare --json lists command result keys; without a command, retain root text help.
      if (formatResolution.source === "json" && extracted.jsonList && argv.length === 0) {
        setActiveResultFormat(DEFAULT_RESULT_FORMAT);
      }
      setActiveJsonControl(resolveJsonControl(extracted, formatResolution.format));
      setActiveJq(extracted.jq);
      if (
        extracted.jq !== undefined &&
        activeJsonControl.mode === "off" &&
        formatResolution.source !== "format"
      ) {
        setActiveResultFormat("json");
      }
    } catch (error) {
      if (error instanceof RendererSelectionError) {
        setActiveCommandId("cli:format-selection");
        await renderPreCommandFailure({
          context,
          commandId: "cli:format-selection",
          error,
          ...preCommandOutputMode({ argv, env: context.env }),
        });
        return;
      }
      throw error;
    }
  } else {
    setActiveResultFormat(DEFAULT_RESULT_FORMAT);
    setActiveJsonControl(JSON_CONTROL_OFF);
    setActiveJq(undefined);
  }

  argv = normalizeCompiledCommandArgv(argv);

  if (argv[0] === "help") {
    if (hostProxy !== undefined) {
      const target = argv[1];
      if (target === undefined || argv.includes("--all")) throw hostProxyDenied("cli:help");
      await runCompiledCli([target, "--help", ...argv.slice(2)], signal, hostProxy, context);
      return;
    }
    const helpArgv = argv.slice(1);
    if (await rejectUnknownHelpFlags(helpArgv, context)) return;
    const target = helpArgv.find((arg) => !arg.startsWith("-"));
    if (target !== undefined && !helpArgv.includes("--all")) {
      await dispatchHelpTarget(target, catalog, signal);
      return;
    }
    if (isEnvelopeResultFormat(activeResultFormat)) {
      setActiveCommandId("cli:help");
      await printHelpCatalogPage(catalog);
      return;
    }
    if (helpArgv.includes("--all")) {
      await printAllHelp(catalog);
      return;
    }
    await printRootHelpPage(catalog);
    return;
  }

  if (await rejectJsonControlConflicts(context)) return;

  if (
    hostProxy === undefined &&
    isHelpTopic(argv[0] ?? "") &&
    argv.slice(1).some((arg) => arg === "--help" || arg === "-h")
  ) {
    await dispatchHelpTarget(argv[0] ?? "", catalog, signal);
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
      passthroughAliasResolution ??
      (await resolveToolingRouteExit(
        argv[0],
        catalog,
        {
          ...(signal === undefined ? {} : { signal }),
          rebuild: hostProxy === undefined,
        },
        context,
      ));
    if (aliasResolution._tag === "Failure") {
      await renderAliasResolutionFailure(aliasResolution.failure, context);
      return;
    }
    const route = aliasResolution.success;
    if (hostProxy !== undefined && route._tag !== "built-in") throw hostProxyDenied("cli:route");
    if (route._tag === "plugin") {
      if (argvTail.includes("--help") || argvTail.includes("-h"))
        await dispatchHelpTarget(route.token, catalog, signal);
      else await tryPluginOwnedCommand(route.token, argvTail, signal, catalog);
      return;
    }
    if (route._tag === "unknown-tooling" || (route._tag === "cache-miss" && !argv[0]?.startsWith("app:"))) {
      if (argvTail.includes("--help") || argvTail.includes("-h")) {
        await dispatchHelpTarget(argv[0] ?? "", catalog, signal);
        return;
      }
      if (
        route._tag === "unknown-tooling" &&
        (await tryPluginOwnedCommand(argv[0] ?? "", argvTail, signal, catalog))
      )
        return;
      const hint = await catalog.remediation(argv[0] ?? "");
      if (hint !== undefined) {
        return renderPreCommandFailure({
          context,
          commandId: route.commandId,
          error: toolingRouteFailure(route, hint),
          rendererMode: activeRendererMode,
          resultFormat: activeResultFormat,
        });
      }
    }
    if (route._tag === "built-in") {
      builtInCommand = route.entry;
      argv = [route.commandId, ...argvTail];
    } else if (route._tag === "alias-disabled") {
      setActiveCommandId("cli:unknown-command");
      await failUnknownCommand(route.token, catalog, false, context);
      return;
    } else if (
      (route._tag === "tooling" || route._tag === "bun-script") &&
      toolingHelpRequested(route, argvTail)
    ) {
      if (route.disabled) await dispatchHelpTarget(route.commandId, catalog, signal);
      else
        await printToolingHelp(
          {
            ...route,
            id: route.commandId,
            ...(route._tag === "bun-script" ? { source: route._tag } : {}),
          },
          route.aliasPolicy,
          context,
        );
      return;
    } else if (
      (route._tag === "tooling" || route._tag === "bun-script") &&
      toolingVersionRequested(route, argvTail)
    ) {
      if (route.disabled) await routeResolvedTooling(route, argvTail, signal, context);
      else {
        const name = typeableName({
          canonicalId: route.commandId,
          builtInAliases: [],
          implicitNamespaceStrip: true,
          ...(route.aliasPolicy === undefined ? {} : { aliasPolicy: route.aliasPolicy }),
        }).primary;
        await renderPreCommandFailure({
          context,
          commandId: route.commandId,
          error: new ToolingInputError({
            tool: route.commandId,
            field: "version",
            message: `\`lando ${name}\` is a project task and has no version of its own.`,
            remediation: `Run \`lando version\` for Lando's version, or \`lando ${name} -- --version\` to pass --version to the task.`,
          }),
          rendererMode: activeRendererMode,
          resultFormat: activeResultFormat,
        });
      }
      return;
    } else if (await routeResolvedTooling(route, argvTail, signal, context)) {
      return;
    }
    if (builtInCommand === undefined) builtInCommand = resolveBuiltInCommand(argv[0]);
  }
  if (signal?.aborted) return;
  const canonicalCommandId = builtInCommand?.spec.id ?? argv[0] ?? "cli:unknown";
  if (hostProxy !== undefined) {
    if (builtInCommand === undefined || !HOST_PROXY_RUNLANDO_ALLOWLIST.includes(canonicalCommandId))
      throw hostProxyDenied(canonicalCommandId);
    await assertHostProxyAppContext(hostProxy, context.cwd);
  }
  if (builtInCommand !== undefined) argv = [canonicalCommandId, ...argv.slice(1)];
  if (canonicalCommandId === "apps:scratch:start" && argv[0] !== undefined) {
    argv = [argv[0], ...normalizeScratchStartArgv(argv.slice(1))];
  }
  setActiveCommandId(canonicalCommandId);
  resetActiveCommandInvocation(canonicalCommandId, argv.slice(1), { context });
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
        if (await rejectUnknownHelpFlags(dispatchArgv, context)) return;
        await printAllHelp(catalog);
        return;
      }
      await printRootHelpPage(catalog);
      return;
    }

    await dispatchHelpTarget(commandArg, catalog, signal);
    return;
  }

  if (
    (dispatchArgv.includes("--version") || dispatchArgv.includes("-v")) &&
    !isBunOrX &&
    !scratchRunHasToolCommand
  ) {
    if (hostProxy !== undefined) throw hostProxyDenied("meta:version");
    const versionSpec = resolveBuiltInCommand("meta:version")?.spec;
    if (await rejectUnsupportedResultFormat("meta:version", versionSpec, { context })) return;
    if (await emitJsonListModeIfRequested(versionSpec?.resultSchema, context)) return;
    if (signal?.aborted) return;
    await runMetaVersion(context);
    return;
  }

  if (found !== undefined) {
    // Before flag validation and before --json key listing: an unsupported
    // format must not be laundered into a successful listing.
    if (await rejectUnsupportedResultFormat(canonicalCommandId, found[1], { context })) return;
    const flagError = validateCommandCliFlags({
      commandId: canonicalCommandId,
      argv: argv.slice(1),
      definitions: flagDefinitionsForCommand(found[1]),
      allowUnknownFlags: isBunOrX || found[1].strict === false,
    });
    if (flagError !== undefined) {
      await runCompiledCommand(Effect.fail(flagError), Layer.empty, () => undefined, {
        context,
        failureExitCode: () => 2,
        preCommand: true,
      });
      return;
    }
    if (await emitJsonListModeIfRequested(found[1].resultSchema, context)) return;
  }

  if (signal?.aborted) return;
  if (builtInCommand?.status.kind === "deferred") {
    const error = notImplementedErrorForCommand(builtInCommand.spec.id);
    if (isEnvelopeResultFormat(activeResultFormat)) {
      await runCompiledCommand(Effect.fail(error), Layer.empty, () => undefined, { context });
      return;
    }
    await emitDiagnosticLine(
      commandErrorMessage({ error, additionalErrors: [] }, canonicalCommandId, undefined, context.env),
      context,
    );
    context.setExitCode(1);
    return;
  }

  if (found === undefined) {
    const token = argv[0] ?? "";
    if (await tryPluginOwnedCommand(token, argv.slice(1), signal, catalog)) return;
    await failUnknownCommand(token, catalog, true, context);
    return;
  }

  if (builtInCommand?.status.kind === "embedding-exempt") {
    await registerBundledPlugins();
    await runNativeOnlyBuiltIn(builtInCommand, argv.slice(1), signal, context);
    return;
  }
  if (builtInCommand !== undefined) {
    await registerBundledPlugins();
    await runBuiltInCommand(builtInCommand, argv.slice(1), signal, hostProxy, context);
    return;
  }

  throw new TypeError(`Implemented command ${found[0]} has no catalog entry.`);
};

export interface RunCliOptions {
  readonly argv: ReadonlyArray<string>;
  readonly rootUrl: string;
  readonly discovery?: DiscoveryOperation;
  readonly signal?: AbortSignal;
  readonly hostProxy?: HostProxyLandoCall;
  readonly context?: CliInvocationContext;
}

export const runCli = async (options: RunCliOptions): Promise<void> => {
  if (options.signal?.aborted) return;
  // A caller that names only a discovery cwd still runs the invocation there.
  const supplied = options.context ?? {
    ...processInvocationContext(),
    ...(options.discovery === undefined ? {} : { cwd: options.discovery.cwd }),
  };
  const context =
    options.hostProxy === undefined
      ? supplied
      : { ...supplied, cwd: await hostProxyCallCwd(options.hostProxy) };
  try {
    await runDiscoveryOperation(
      options.discovery ?? { cwd: context.cwd, resolver: makeAppDiscoveryResolver() },
      () => runCompiledCli(options.argv, options.signal, options.hostProxy, context),
    );
  } catch (error) {
    const cause = Cause.isCause(error) ? error : Cause.die(error);
    if (options.signal?.aborted && Cause.hasInterruptsOnly(cause)) return;
    const logLevel = Effect.runSync(
      Effect.result(
        Effect.try({
          try: () => resolveLogLevel({ argv: options.argv, env: context.env }),
          catch: (selectionError) => selectionError,
        }),
      ),
    );
    if (logLevel._tag === "Success" && logLevel.success.source !== "default") {
      setActiveLogLevel(logLevel.success.level);
    }
    const output = preCommandOutputMode({ argv: options.argv, env: context.env });
    setActiveRendererMode(output.rendererMode);
    if (output.resultFormat !== undefined) setActiveResultFormat(output.resultFormat);
    await runCompiledCommand(Effect.failCause(cause), Layer.empty, () => undefined, {
      context,
      preCommand: true,
    });
  }
};
