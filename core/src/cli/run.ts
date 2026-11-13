import { HOST_PROXY_WORKER_COMMAND } from "@lando/engine/subsystems/host-proxy/worker";
import { AGENT_RELAY_WORKER_COMMAND } from "@lando/engine/subsystems/ssh-agent/worker-protocol";
import { type DiscoveryOperation, runDiscoveryOperation } from "@lando/landofile/operation-scope";
import { makeAppDiscoveryResolver } from "@lando/landofile/traversal-policy";
import {
  JsonJqConflictError,
  JsonProjectionError,
  LogLevelSelectionError,
  NotImplementedError,
  RendererSelectionError,
  ToolingInputError,
} from "@lando/sdk/errors";
import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { Cause, Effect, Exit, Layer } from "effect";
import {
  CliInvocation,
  type CliInvocationContext,
  processInvocationContext,
} from "../runtime/invocation-context";
import { rejectCommandCliArgValues } from "./arg-value-validation";
import {
  type BuiltInCommandEntry,
  isReservedNamespaceHead,
  notImplementedErrorForCommand,
  resolveBuiltInCommand,
} from "./built-in-command-registry";
import { runMetaVersion } from "./cli-adapters/meta-plugin";
import { isHelpTopic } from "./cold-path-output";
import type { ScratchStartOptions } from "./commands/scratch";
import { normalizeScratchStartArgv, scratchStartOptionsFromInput } from "./commands/scratch";
import {
  type CompiledCommand,
  builtInTailPolicy,
  findCommand,
  flagDefinitionsForCommand,
} from "./compiled-argv";
import { COMPILED_DECODER_ASTS } from "./compiled-decoder-targets";
import { printToolingHelp } from "./compiled-help";
import { compiledCommandInputFromArgv } from "./compiled-input";
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
import { type TailPolicy, resolveInvocationHead, splitInvocation } from "./invocation";
import { resolveLogLevel } from "./log-level-selection";
import { runNativeOnlyBuiltIn } from "./native-only-built-in-adapters";
import { type PluginCommandCatalog, createPluginCommandCatalog } from "./plugin-command-catalog";
import { pluginTailPolicy } from "./plugin-flag-definitions";
import { pluginDispatcherArgv } from "./plugin-owned-command-input";
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
import { resolveTopLevelAliases } from "./spec/command-spec";
import {
  resolveToolingRoute,
  toolingHelpRequested,
  toolingRouteFailure,
  toolingVersionRequested,
  unavailableScriptError,
} from "./tooling-router";
import { resolveTrace, setActiveTrace } from "./trace-selection";
import { unknownCommandError } from "./unknown-command-error";

export { renderCompiledDoctorReport } from "./cli-adapters/app-lifecycle";
export { normalizeCompiledCommandArgv } from "./compiled-normalize";
export { compiledCommandInputFromArgv };

export const parseScratchStartArgv = (argv: ReadonlyArray<string>): ScratchStartOptions =>
  scratchStartOptionsFromInput(compiledCommandInputFromArgv("apps:scratch:start", argv));

const failUnknownCommand = async (
  argv: ReadonlyArray<string>,
  catalog: PluginCommandCatalog,
  suggest = true,
  context?: CliInvocationContext,
) => {
  setActiveCommandId("cli:unknown-command");
  return renderPreCommandFailure({
    ...(context === undefined ? {} : { context }),
    commandId: "cli:unknown-command",
    error: unknownCommandError(argv[0] ?? "", suggest ? await catalog.unknownCommandGuidance(argv) : {}),
    rendererMode: activeRendererMode,
    resultFormat: activeResultFormat,
    usage: true,
  });
};

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
    usage: true,
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

const applyRendererSelections = async (
  argv: ReadonlyArray<string>,
  context: CliInvocationContext,
  configGlobals: Awaited<ReturnType<typeof readConfigCliGlobals>>,
  protocolStdout: boolean,
): Promise<ReadonlyArray<string>> => {
  const trace = resolveTrace({
    argv,
    env: context.env,
    ...(configGlobals.tracing === undefined ? {} : { config: configGlobals.tracing }),
  });
  setActiveTrace(trace);
  const logLevelResolution = resolveLogLevel({
    argv: trace.remainingArgv,
    env: context.env,
    ...(configGlobals.logLevel === undefined ? {} : { configValue: configGlobals.logLevel }),
  });
  setActiveLogLevel(logLevelResolution.level);
  const resolution = await resolveCliRendererMode({
    argv: logLevelResolution.remainingArgv,
    env: context.env,
    loadConfigRenderer: async () => configGlobals.renderer,
  });
  const mode = protocolStdout
    ? resolution.mode
    : applyDebugRendererFlip({ verbose: logLevelResolution.verbose, renderer: resolution });
  setActiveRendererMode(mode);
  return resolution.remainingArgv;
};

const applyFormatSelections = (
  argv: ReadonlyArray<string>,
  context: CliInvocationContext,
  commandAbsent: boolean,
): void => {
  const deprecationWarnings = resolveCliDeprecationWarnings({ argv, env: context.env });
  setActiveDeprecationWarnings(deprecationWarnings.enabled);
  const extracted = extractFormatFlags(deprecationWarnings.remainingArgv);
  const formatResolution = resolveResultFormat({
    argv: deprecationWarnings.remainingArgv,
    rendererMode: activeRendererMode,
  });
  setActiveResultFormat(formatResolution.format);
  // Bare --json lists command result keys; without a command, retain root text help.
  if (formatResolution.source === "json" && extracted.jsonList && commandAbsent) {
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
};

const applyInvocationSelections = async (
  globals: ReadonlyArray<string>,
  context: CliInvocationContext,
  configGlobals: Awaited<ReturnType<typeof readConfigCliGlobals>>,
  selection: { readonly protocolStdout: boolean; readonly commandAbsent: boolean },
): Promise<boolean> => {
  let rendererSelected = false;
  try {
    const remaining = await applyRendererSelections(
      globals,
      context,
      configGlobals,
      selection.protocolStdout,
    );
    rendererSelected = true;
    applyFormatSelections(remaining, context, selection.commandAbsent);
  } catch (error) {
    if (
      !(
        error instanceof RendererSelectionError ||
        (!rendererSelected &&
          (error instanceof LogLevelSelectionError || error instanceof NotImplementedError))
      )
    )
      throw error;
    let commandId = "cli:format-selection";
    if (!rendererSelected) {
      commandId =
        error instanceof LogLevelSelectionError ? "cli:log-level-selection" : "cli:renderer-selection";
    }
    setActiveCommandId(commandId);
    await renderPreCommandFailure({
      context,
      commandId,
      error,
      ...preCommandOutputMode({ argv: globals, env: context.env }),
      usage: true,
    });
    return true;
  }
  return false;
};

// Help and listing paths stay free of bundled plugin modules; command dispatch registers them before building a runtime.
const registerBundledPlugins = () => import("../runtime/bundled-plugins");

const runCompiledCli = async (
  rawArgv: ReadonlyArray<string>,
  signal?: AbortSignal,
  hostProxy?: HostProxyLandoCall,
  context: CliInvocationContext = processInvocationContext(),
  /** Receives the tokens Lando owns once argv is split, for the caller's failure rendering. */
  onLandoGlobals: (globals: ReadonlyArray<string>) => void = () => undefined,
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

  setActiveTrace(undefined);
  const configGlobals = await readConfigCliGlobals(context.env);

  const head = resolveInvocationHead(rawArgv);
  const commandToken = head.commandId;
  const isHelpCommand = commandToken === "help";
  let builtInCommand: BuiltInCommandEntry | undefined;
  let routeResolution: Awaited<ReturnType<typeof resolveToolingRouteExit>> | undefined;
  let routeSkipped = false;
  const registered = commandToken === undefined ? undefined : resolveBuiltInCommand(commandToken);
  if (registered !== undefined && registered.spec.id === commandToken) builtInCommand = registered;
  if (commandToken !== undefined && !isHelpCommand && builtInCommand === undefined) {
    // A lead that already selects an unusable mode fails before routing, which
    // may import plugin modules to rebuild the command index.
    if (
      head.headGlobals.length > 0 &&
      (await applyInvocationSelections(head.headGlobals, context, configGlobals, {
        protocolStdout: false,
        commandAbsent: false,
      }))
    )
      return;
    if (
      !commandToken.startsWith("-") &&
      (registered !== undefined || !isReservedNamespaceHead(commandToken))
    ) {
      routeResolution = await resolveToolingRouteExit(
        commandToken,
        catalog,
        {
          ...(signal === undefined ? {} : { signal }),
          // A host-proxy child reads the app's alias policy but never rebuilds the index.
          rebuild: hostProxy === undefined,
          // Output modes are not resolved yet; machine-output argv/env still silences the notice.
          rebuildNotice: preCommandOutputMode({ argv: rawArgv, env: context.env }).rendererMode !== "json",
        },
        context,
      );
    } else {
      routeSkipped = true;
    }
  }
  const route = routeResolution?._tag === "Success" ? routeResolution.success : undefined;
  // Host-proxy admission: only a built-in may own the token, decided before any plugin code loads.
  if (hostProxy !== undefined && route !== undefined && route._tag !== "built-in")
    throw hostProxyDenied("cli:route");
  if (route?._tag === "built-in") builtInCommand = route.entry;
  // A route that does not claim the token leaves a built-in alias (bun, x, run)
  // as the owner; a failed route still renders its own diagnostic.
  if (
    builtInCommand === undefined &&
    routeResolution?._tag !== "Failure" &&
    (route === undefined || route._tag === "not-tooling" || route._tag === "cache-miss")
  ) {
    builtInCommand = resolveBuiltInCommand(commandToken);
  }

  let pluginToken: string | undefined;
  if (
    hostProxy === undefined &&
    builtInCommand === undefined &&
    !isHelpCommand &&
    commandToken !== undefined
  ) {
    switch (route?._tag) {
      case "plugin":
        pluginToken = route.token;
        break;
      case "unknown-tooling":
      case "not-tooling":
        pluginToken = commandToken;
        break;
      case undefined:
        if (routeSkipped) pluginToken = commandToken;
        break;
      case "built-in":
      case "tooling":
      case "bun-script":
      case "cache-miss":
      case "alias-disabled":
        break;
      default:
        route satisfies never;
    }
  }
  let pluginSpec: ExecutableCommandSpec | undefined;
  let pluginSelectionFailed = false;
  if (pluginToken !== undefined) {
    const row = await catalog.resolve(pluginToken);
    if (row !== undefined) {
      if ("unavailable" in row || row.loadError !== undefined || row.spec === undefined)
        pluginSelectionFailed = true;
      else pluginSpec = row.spec;
    }
  }

  let policy: TailPolicy;
  if (builtInCommand !== undefined) policy = builtInTailPolicy(builtInCommand.spec);
  else if (pluginSpec !== undefined) policy = pluginTailPolicy(pluginSpec);
  else if (pluginSelectionFailed) policy = { kind: "all" };
  else if (route?._tag === "tooling" || route?._tag === "bun-script") {
    if (route.disabled) policy = { kind: "none" };
    else if (route.wrapper) policy = { kind: "all" };
    else policy = { kind: "declared", flags: route.input?.flags ?? [] };
  } else policy = { kind: "none" };

  const split = splitInvocation(rawArgv, head, policy);
  const globals = split.globals;
  onLandoGlobals(globals);
  let argv: ReadonlyArray<string> = split.argv;
  const commandTail = split.tailLength === 0 ? [] : argv.slice(argv.length - split.tailLength);
  const landoArgv = split.tailLength === 0 ? argv : argv.slice(0, argv.length - split.tailLength);
  if (
    await applyInvocationSelections(globals, context, configGlobals, {
      protocolStdout: builtInCommand?.spec.id === "meta:mcp",
      commandAbsent: split.argv.length === 0,
    })
  )
    return;

  if (argv[0] === "help") {
    if (hostProxy !== undefined) {
      const target = argv[1];
      if (target === undefined || argv.includes("--all")) throw hostProxyDenied("cli:help");
      await runCompiledCli(
        [...globals, target, "--help", ...argv.slice(2)],
        signal,
        hostProxy,
        context,
        onLandoGlobals,
      );
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

  const answerLandoVersion = async (): Promise<void> => {
    if (hostProxy !== undefined) throw hostProxyDenied("meta:version");
    const versionSpec = resolveBuiltInCommand("meta:version")?.spec;
    if (await rejectUnsupportedResultFormat("meta:version", versionSpec, { context })) return;
    if (await emitJsonListModeIfRequested(versionSpec?.resultSchema, context)) return;
    if (signal?.aborted) return;
    await runMetaVersion(context);
  };

  if (builtInCommand === undefined && routeResolution !== undefined) {
    const argvTail = argv.slice(1);
    if (routeResolution._tag === "Failure") {
      await renderAliasResolutionFailure(routeResolution.failure, context);
      return;
    }
    const resolvedRoute = routeResolution.success;
    // Lando reads a plugin command's argv only before its tail; a plugin that failed to load owns all of it.
    const pluginLead = pluginSelectionFailed ? [] : pluginDispatcherArgv(pluginSpec, argvTail);
    const helpRequested = pluginLead.includes("--help") || pluginLead.includes("-h");
    if (resolvedRoute._tag === "plugin") {
      if (helpRequested) await dispatchHelpTarget(resolvedRoute.token, catalog, signal);
      else if (pluginLead.includes("--version") || pluginLead.includes("-v")) await answerLandoVersion();
      else await tryPluginOwnedCommand(resolvedRoute.token, argvTail, signal, catalog);
      return;
    }
    if (
      resolvedRoute._tag === "unknown-tooling" ||
      (resolvedRoute._tag === "cache-miss" && !argv[0]?.startsWith("app:"))
    ) {
      if (helpRequested) {
        await dispatchHelpTarget(argv[0] ?? "", catalog, signal);
        return;
      }
      if (resolvedRoute._tag === "unknown-tooling") {
        if (!(await tryPluginOwnedCommand(argv[0] ?? "", argvTail, signal, catalog)))
          await failUnknownCommand(argv, catalog, true, context);
        return;
      }
      const hint = await catalog.remediation(argv[0] ?? "");
      if (hint !== undefined) {
        return renderPreCommandFailure({
          context,
          commandId: resolvedRoute.commandId,
          error: toolingRouteFailure(resolvedRoute, hint),
          rendererMode: activeRendererMode,
          resultFormat: activeResultFormat,
        });
      }
    }
    if (resolvedRoute._tag === "alias-disabled") {
      await failUnknownCommand([resolvedRoute.token], catalog, false, context);
      return;
    }
    if (
      (resolvedRoute._tag === "tooling" || resolvedRoute._tag === "bun-script") &&
      toolingHelpRequested(resolvedRoute, argvTail)
    ) {
      const unavailable = await Effect.runPromise(unavailableScriptError(resolvedRoute));
      if (resolvedRoute.disabled) await dispatchHelpTarget(resolvedRoute.commandId, catalog, signal);
      else if (unavailable !== undefined)
        await renderAliasResolutionFailure(unavailable, context, resolvedRoute.commandId);
      else
        await printToolingHelp(
          {
            ...resolvedRoute,
            id: resolvedRoute.commandId,
            ...(resolvedRoute._tag === "bun-script" ? { source: resolvedRoute._tag } : {}),
          },
          resolvedRoute.aliasPolicy,
          context,
        );
      return;
    }
    if (
      (resolvedRoute._tag === "tooling" || resolvedRoute._tag === "bun-script") &&
      toolingVersionRequested(resolvedRoute, argvTail)
    ) {
      if (resolvedRoute.disabled) await routeResolvedTooling(resolvedRoute, argvTail, signal, context);
      else {
        const name = typeableName({
          canonicalId: resolvedRoute.commandId,
          builtInAliases: [],
          implicitNamespaceStrip: true,
          ...(resolvedRoute.aliasPolicy === undefined ? {} : { aliasPolicy: resolvedRoute.aliasPolicy }),
        }).primary;
        await renderPreCommandFailure({
          context,
          commandId: resolvedRoute.commandId,
          error: new ToolingInputError({
            tool: resolvedRoute.commandId,
            field: "version",
            message: `\`lando ${name}\` is a project task and has no version of its own.`,
            remediation: `Run \`lando version\` for Lando's version, or \`lando ${name} -- --version\` to pass --version to the task.`,
          }),
          rendererMode: activeRendererMode,
          resultFormat: activeResultFormat,
        });
      }
      return;
    }
    if (await routeResolvedTooling(resolvedRoute, argvTail, signal, context)) return;
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

  const found: [string, CompiledCommand] | undefined =
    builtInCommand === undefined ? findCommand(argv[0] ?? "") : [builtInCommand.spec.id, builtInCommand.spec];
  const dashDashIndex = landoArgv.indexOf("--");
  const dispatchArgv = dashDashIndex === -1 ? landoArgv : landoArgv.slice(0, dashDashIndex);
  const separatorInTail = commandTail.indexOf("--");
  const beforeTailSeparator = separatorInTail === -1 ? commandTail : commandTail.slice(0, separatorInTail);
  const passthroughHelp =
    policy.kind === "all" &&
    beforeTailSeparator.length > 0 &&
    beforeTailSeparator.every((arg) => arg === "--help" || arg === "-h");

  if (
    passthroughHelp ||
    (policy.kind !== "all" &&
      (dispatchArgv.length === 0 || dispatchArgv.includes("--help") || dispatchArgv.includes("-h")))
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

  if (dispatchArgv.includes("--version") || dispatchArgv.includes("-v")) {
    await answerLandoVersion();
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
      allowUnknownFlags: found[1].strict === false,
      tailPolicy: builtInTailPolicy(found[1]),
      commandName: typeableName({
        canonicalId: canonicalCommandId,
        builtInAliases: builtInCommand === undefined ? [] : resolveTopLevelAliases(builtInCommand.spec),
      }).primary,
    });
    if (flagError !== undefined) {
      await runCompiledCommand(Effect.fail(flagError), Layer.empty, () => undefined, {
        context,
        preCommand: true,
        usage: true,
      });
      return;
    }
    if (await rejectCommandCliArgValues(canonicalCommandId, argv.slice(1), context)) return;
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
    await failUnknownCommand(argv, catalog, true, context);
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
  let landoGlobals: ReadonlyArray<string> | undefined;
  // A caller that names only a discovery cwd still runs the invocation there.
  const supplied = options.context ?? {
    ...processInvocationContext(),
    ...(options.discovery === undefined ? {} : { cwd: options.discovery.cwd }),
  };
  let context = supplied;
  try {
    if (options.hostProxy !== undefined) {
      context = { ...supplied, cwd: await hostProxyCallCwd(options.hostProxy) };
    }
    await runDiscoveryOperation(
      options.discovery ?? { cwd: context.cwd, resolver: makeAppDiscoveryResolver() },
      () =>
        runCompiledCli(options.argv, options.signal, options.hostProxy, context, (globals) => {
          landoGlobals = globals;
        }),
    );
  } catch (error) {
    const cause = Cause.isCause(error) ? error : Cause.die(error);
    if (options.signal?.aborted && Cause.hasInterruptsOnly(cause)) return;
    // Before argv is split, the raw tokens are the only evidence of the requested output mode.
    const landoArgv = landoGlobals ?? options.argv;
    const logLevel = Effect.runSync(
      Effect.result(
        Effect.try({
          try: () => resolveLogLevel({ argv: landoArgv, env: context.env }),
          catch: (selectionError) => selectionError,
        }),
      ),
    );
    if (logLevel._tag === "Success" && logLevel.success.source !== "default") {
      setActiveLogLevel(logLevel.success.level);
    }
    const output = preCommandOutputMode({ argv: landoArgv, env: context.env });
    setActiveRendererMode(output.rendererMode);
    if (output.resultFormat !== undefined) setActiveResultFormat(output.resultFormat);
    await runCompiledCommand(Effect.failCause(cause), Layer.empty, () => undefined, {
      context,
      preCommand: true,
    });
  }
};
