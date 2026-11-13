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
import { Cause, Effect, Layer } from "effect";
import { type CliInvocationContext, processInvocationContext } from "../runtime/invocation-context";
import { rejectCommandCliArgValues } from "./arg-value-validation";
import { notImplementedErrorForCommand, resolveBuiltInCommand } from "./built-in-command-registry";
import { runMetaVersion } from "./cli-adapters/meta-plugin";
import { isHelpTopic } from "./cold-path-output";
import type { ScratchStartOptions } from "./commands/scratch";
import { normalizeScratchStartArgv, scratchStartOptionsFromInput } from "./commands/scratch";
import { flagDefinitionsForCommand } from "./compiled-argv";
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
import { resolveInvocationHead, splitInvocation } from "./invocation";
import { type InvocationOwner, ownerPolicy, resolveInvocationOwner } from "./invocation-owner";
import { matchLandoFlag } from "./lando-flags";
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
import { dispatchPluginUnavailable, tryPluginOwnedCommand } from "./run-plugin-owned-command";
import { preCommandOutputMode, renderPreCommandFailure } from "./spec/command-boundary";
import { resolveTopLevelAliases } from "./spec/command-spec";
import { toolingRouteFailure, toolingVersionRequested, unavailableScriptError } from "./tooling-router";
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

/** The command id host-proxy denial names: the first token that is not one of Lando's selection flags. */
const hostProxyDenyToken = (argv: ReadonlyArray<string>): string => {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    const match = matchLandoFlag(token, argv[index + 1]);
    if (match !== undefined && match.flag.role === "selection") {
      index += match.consumed;
      continue;
    }
    return token;
  }
  return "cli:unknown";
};

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
  const owner = await resolveInvocationOwner({
    head,
    rawArgv,
    catalog,
    context,
    hostProxy: hostProxy !== undefined,
    ...(signal === undefined ? {} : { signal }),
    precheckLeadingFlags: (globals) =>
      applyInvocationSelections(globals, context, configGlobals, {
        protocolStdout: false,
        commandAbsent: false,
      }),
  });
  if (owner === "handled") return;

  const policy = ownerPolicy(owner);
  const split = splitInvocation(rawArgv, head, policy);
  onLandoGlobals(split.globals);
  const tokens = split.command;
  const commandAbsent = owner.kind === "none" && tokens.argv.length === 0 && split.controls.length === 0;
  if (
    await applyInvocationSelections(split.globals, context, configGlobals, {
      protocolStdout: owner.kind === "built-in" && owner.entry.spec.id === "meta:mcp",
      commandAbsent,
    })
  )
    return;

  const answerLandoVersion = async (): Promise<void> => {
    if (hostProxy !== undefined) throw hostProxyDenied("meta:version");
    const versionSpec = resolveBuiltInCommand("meta:version")?.spec;
    if (await rejectUnsupportedResultFormat("meta:version", versionSpec, { context })) return;
    if (await emitJsonListModeIfRequested(versionSpec?.resultSchema, context)) return;
    if (signal?.aborted) return;
    await runMetaVersion(context);
  };

  if (owner.kind === "help") {
    if (hostProxy !== undefined) {
      const target = tokens.argv.find((arg) => !arg.startsWith("-"));
      if (target === undefined || tokens.argv.includes("--all")) throw hostProxyDenied("cli:help");
      const targetIndex = tokens.argv.indexOf(target);
      await runCompiledCli(
        [...split.globals, target, "--help", ...tokens.argv.slice(targetIndex + 1), ...split.controls],
        signal,
        hostProxy,
        context,
        onLandoGlobals,
      );
      return;
    }
    if (await rejectUnknownHelpFlags([...tokens.argv, ...split.controls], context)) return;
    const target = tokens.argv.find((arg) => !arg.startsWith("-"));
    if (target !== undefined && !tokens.argv.includes("--all")) {
      await dispatchHelpTarget(target, catalog, signal);
      return;
    }
    if (isEnvelopeResultFormat(activeResultFormat)) {
      setActiveCommandId("cli:help");
      await printHelpCatalogPage(catalog);
      return;
    }
    if (tokens.argv.includes("--all")) {
      await printAllHelp(catalog);
      return;
    }
    await printRootHelpPage(catalog);
    return;
  }

  if (await rejectJsonControlConflicts(context)) return;

  if (hostProxy === undefined && split.help && isHelpTopic(head.commandId ?? "")) {
    await dispatchHelpTarget(head.commandId ?? "", catalog, signal);
    return;
  }

  if (owner.kind === "route-failure") {
    await renderAliasResolutionFailure(owner.failure, context);
    return;
  }

  // Host-proxy admission for everything else: only an allowlisted built-in may
  // proceed, decided before help, version, or unknown-command handling.
  if (hostProxy !== undefined) {
    const canonical = owner.kind === "built-in" ? owner.entry.spec.id : undefined;
    if (canonical === undefined || !HOST_PROXY_RUNLANDO_ALLOWLIST.includes(canonical)) {
      throw hostProxyDenied(canonical ?? hostProxyDenyToken(rawArgv));
    }
    await assertHostProxyAppContext(hostProxy, context.cwd);
  }

  if (signal?.aborted) return;

  const failUnknown = (argv: ReadonlyArray<string>, suggest = true) =>
    failUnknownCommand(argv, catalog, suggest, context);

  const runBuiltInOwner = async (
    entry: Extract<InvocationOwner, { kind: "built-in" }>["entry"],
  ): Promise<void> => {
    const command =
      entry.spec.id === "apps:scratch:start"
        ? { argv: normalizeScratchStartArgv(tokens.argv), tailStart: tokens.tailStart }
        : tokens;
    if (entry.spec.id === "meta:mcp") {
      const terminator = command.argv.indexOf("--");
      const beforeTerminator = terminator === -1 ? command.argv : command.argv.slice(0, terminator);
      if (!beforeTerminator.includes("--list")) setActiveLogLevel("none");
    }
    // `bun` and `x` own their tail, so a lone help spelling there is Lando's.
    if (policy.tail === "all") {
      const tail = command.argv.slice(command.tailStart);
      const separator = tail.indexOf("--");
      const beforeSeparator = separator === -1 ? tail : tail.slice(0, separator);
      if (beforeSeparator.length > 0 && beforeSeparator.every((arg) => arg === "-h" || arg === "--help")) {
        await dispatchHelpTarget(entry.spec.id, catalog, signal);
        return;
      }
    }
    if (split.help) {
      await dispatchHelpTarget(entry.spec.id, catalog, signal);
      return;
    }
    if (split.version) {
      await answerLandoVersion();
      return;
    }
    setActiveCommandId(entry.spec.id);
    resetActiveCommandInvocation(entry.spec.id, command.argv, { context });
    // Before flag validation and before --json key listing: an unsupported
    // format must not be laundered into a successful listing.
    if (await rejectUnsupportedResultFormat(entry.spec.id, entry.spec, { context })) return;
    const flagError = validateCommandCliFlags({
      commandId: entry.spec.id,
      argv: command.argv.slice(0, command.tailStart),
      definitions: flagDefinitionsForCommand(entry.spec),
      allowUnknownFlags: entry.spec.strict === false,
      ...(policy.tail === "command"
        ? {
            commandTail: {
              commandName: typeableName({
                canonicalId: entry.spec.id,
                builtInAliases: resolveTopLevelAliases(entry.spec),
              }).primary,
            },
          }
        : {}),
    });
    if (flagError !== undefined) {
      await runCompiledCommand(Effect.fail(flagError), Layer.empty, () => undefined, {
        context,
        preCommand: true,
        usage: true,
      });
      return;
    }
    if (await rejectCommandCliArgValues(entry.spec.id, command, context)) return;
    if (await emitJsonListModeIfRequested(entry.spec.resultSchema, context)) return;
    if (entry.status.kind === "deferred") {
      const error = notImplementedErrorForCommand(entry.spec.id);
      if (isEnvelopeResultFormat(activeResultFormat)) {
        await runCompiledCommand(Effect.fail(error), Layer.empty, () => undefined, { context });
        return;
      }
      await emitDiagnosticLine(
        commandErrorMessage({ error, additionalErrors: [] }, entry.spec.id, undefined, context.env),
        context,
      );
      context.setExitCode(1);
      return;
    }
    await registerBundledPlugins();
    if (entry.status.kind === "embedding-exempt") {
      await runNativeOnlyBuiltIn(entry, command, signal, context);
      return;
    }
    await runBuiltInCommand(entry, command, signal, hostProxy, context);
  };

  switch (owner.kind) {
    case "none": {
      const separator = tokens.argv.indexOf("--");
      const beforeSeparator = separator === -1 ? tokens.argv : tokens.argv.slice(0, separator);
      if (split.help) {
        const target = beforeSeparator.find((arg) => !arg.startsWith("-"));
        if (target === undefined) {
          if (beforeSeparator.includes("--all")) {
            if (await rejectUnknownHelpFlags([...tokens.argv, ...split.controls], context)) return;
            await printAllHelp(catalog);
            return;
          }
          await printRootHelpPage(catalog);
          return;
        }
        await dispatchHelpTarget(target, catalog, signal);
        return;
      }
      if (split.version) {
        await answerLandoVersion();
        return;
      }
      if (beforeSeparator.length === 0) {
        await printRootHelpPage(catalog);
        return;
      }
      await failUnknown(tokens.argv);
      return;
    }
    case "built-in":
      await runBuiltInOwner(owner.entry);
      return;
    case "tooling": {
      const route = owner.route;
      if (split.help) {
        const unavailable = await Effect.runPromise(unavailableScriptError(route));
        if (route.disabled) await dispatchHelpTarget(route.commandId, catalog, signal);
        else if (unavailable !== undefined)
          await renderAliasResolutionFailure(unavailable, context, route.commandId);
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
      }
      if (toolingVersionRequested(route, tokens.argv)) {
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
        return;
      }
      await routeResolvedTooling(route, tokens.argv, signal, context);
      return;
    }
    case "plugin": {
      if (split.help) {
        await dispatchHelpTarget(owner.token, catalog, signal);
        return;
      }
      if (split.version) {
        await answerLandoVersion();
        return;
      }
      await tryPluginOwnedCommand(owner.token, owner.row, tokens, signal, catalog);
      return;
    }
    case "plugin-unloaded": {
      const outcome = await dispatchPluginUnavailable(owner.token, owner.row, tokens, catalog);
      if (outcome === "unknown") await failUnknown([owner.token, ...tokens.argv]);
      return;
    }
    case "cache-miss": {
      const route = owner.route;
      if (!owner.token.startsWith("app:")) {
        if (split.help) {
          await dispatchHelpTarget(owner.token, catalog, signal);
          return;
        }
        const hint = await catalog.remediation(owner.token);
        if (hint !== undefined) {
          await renderPreCommandFailure({
            context,
            commandId: route.commandId,
            error: toolingRouteFailure(route, hint),
            rendererMode: activeRendererMode,
            resultFormat: activeResultFormat,
          });
          return;
        }
      }
      await routeResolvedTooling(route, tokens.argv, signal, context);
      return;
    }
    case "alias-disabled":
      await failUnknown([owner.token], false);
      return;
    case "unknown": {
      if (split.help) {
        await dispatchHelpTarget(owner.token, catalog, signal);
        return;
      }
      await failUnknown([owner.token, ...tokens.argv]);
      return;
    }
    default:
      return owner satisfies never;
  }
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
