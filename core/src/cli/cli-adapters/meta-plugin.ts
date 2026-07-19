import { Effect, Layer } from "effect";

import { type LandoRuntimeBootstrapError, NotImplementedError } from "@lando/sdk/errors";
import type { ConfigService } from "@lando/sdk/services";
import type { RedactionService } from "../../redaction/service.ts";

import { cliRuntimeOptions } from "../../runtime/cli-options.ts";
import { makeLandoRuntime } from "../../runtime/layer.ts";
import { metaBun, metaX, renderMetaBunResult, renderMetaXResult } from "../commands/bun.ts";
import { globalConfig, renderGlobalConfigResult } from "../commands/meta/global-config.ts";
import { globalDestroy, renderGlobalDestroyResult } from "../commands/meta/global-destroy.ts";
import { globalInfo, renderGlobalInfoResult } from "../commands/meta/global-info.ts";
import { globalInstall, renderGlobalInstallResult } from "../commands/meta/global-install.ts";
import { DefaultGlobalListLayer, globalList, renderGlobalListResult } from "../commands/meta/global-list.ts";
import { followGlobalLogs, globalLogs, renderGlobalLogsResult } from "../commands/meta/global-logs.ts";
import { globalRebuild, renderGlobalRebuildResult } from "../commands/meta/global-rebuild.ts";
import { globalRestart, renderGlobalRestartResult } from "../commands/meta/global-restart.ts";
import { globalStart, renderGlobalStartResult } from "../commands/meta/global-start.ts";
import { globalStatus, renderGlobalStatusResult } from "../commands/meta/global-status.ts";
import { globalStop, renderGlobalStopResult } from "../commands/meta/global-stop.ts";
import { globalUninstall, renderGlobalUninstallResult } from "../commands/meta/global-uninstall.ts";
import { dispatchMcpCommand, mcpFlagsFromParsed, mcpRegistryFromCompiled } from "../commands/meta/mcp.ts";
import { pluginAdd, renderPluginAddResult } from "../commands/plugin-add.ts";
import { pluginBuild, renderPluginBuildResult } from "../commands/plugin-build.ts";
import { pluginLink, renderPluginLinkResult } from "../commands/plugin-link.ts";
import { pluginNew, renderPluginNewResult } from "../commands/plugin-new.ts";
import {
  type PluginPublishOptions,
  pluginPublish,
  renderPluginPublishResult,
} from "../commands/plugin-publish.ts";
import { pluginRemove, renderPluginRemoveResult } from "../commands/plugin-remove.ts";
import { pluginTest, renderPluginTestResult } from "../commands/plugin-test.ts";
import {
  pluginTrust,
  pluginTrustAuthoringRoot,
  pluginTrustList,
  pluginTrustRevoke,
  renderPluginTrustAuthoringRootResult,
  renderPluginTrustListResult,
  renderPluginTrustResult,
  renderPluginTrustRevokeResult,
} from "../commands/plugin-trust.ts";
import { pluginUnlink, renderPluginUnlinkResult } from "../commands/plugin-unlink.ts";
import {
  recipePathFromInput,
  recipeRefFromInput,
  recipesDescribe,
  recipesList,
  recipesValidate,
  renderRecipesDescribeResult,
  renderRecipesListResult,
  renderRecipesValidateResult,
} from "../commands/recipes.ts";
import { renderShellenv } from "../commands/shellenv.ts";
import { renderUninstallResult, uninstall } from "../commands/uninstall.ts";
import { version as versionOperation } from "../commands/version.ts";
import { commandEntries, compiledManifest } from "../compiled-argv.ts";
import { compiledCommandInputFromArgv } from "../compiled-input.ts";
import {
  activeRendererMode,
  activeResultFormat,
  commandErrorMessage,
  emitDiagnosticLine,
  getActiveCommandInvocation,
  globalRuntimeLayer,
  rejectInvalidInvocation,
  resetActiveCommandInvocation,
  resolveCompiledCommandRuntime,
  runCompiledCommand,
  runWithProcessAbortSignal,
  setActiveCommandId,
} from "../compiled-runtime.ts";
import type { LandoCommandSpec } from "../oclif/command-base.ts";
import {
  globalConfigFormatFromInput,
  globalConfigOptionsFromInput,
} from "../oclif/commands/meta/global/config.ts";
import { globalDestroyOptionsFromInput } from "../oclif/commands/meta/global/destroy.ts";
import { globalInfoOptionsFromInput } from "../oclif/commands/meta/global/info.ts";
import { globalInstallOptionsFromInput } from "../oclif/commands/meta/global/install.ts";
import { globalLogsFollowFromInput, globalLogsOptionsFromInput } from "../oclif/commands/meta/global/logs.ts";
import { globalStartOptionsFromInput } from "../oclif/commands/meta/global/start.ts";
import {
  globalStatusFormatFromInput,
  globalStatusOptionsFromInput,
} from "../oclif/commands/meta/global/status.ts";
import { globalUninstallOptionsFromInput } from "../oclif/commands/meta/global/uninstall.ts";
import { shellenvShellFromInput } from "../oclif/commands/meta/shellenv.ts";
import { uninstallOptionsFromInput } from "../oclif/commands/meta/uninstall.ts";
import compiledCommands from "../oclif/compiled-commands.ts";
import { resolveNonInteractive } from "../prompts/answer-flags.ts";

export const runMetaGlobalStart = (argv: ReadonlyArray<string>): Promise<void> =>
  runWithProcessAbortSignal((signal) =>
    runCompiledCommand(
      globalStart(
        globalStartOptionsFromInput(compiledCommandInputFromArgv("meta:global:start", argv, { signal })),
      ),
      globalRuntimeLayer(),
      renderGlobalStartResult,
    ),
  );

export const runMetaGlobalStop = (): Promise<void> =>
  runCompiledCommand(globalStop(), globalRuntimeLayer(), renderGlobalStopResult);

export const runMetaGlobalStatus = (argv: ReadonlyArray<string>): Promise<void> => {
  const input = compiledCommandInputFromArgv("meta:global:status", argv);
  return runCompiledCommand(
    globalStatus(globalStatusOptionsFromInput(input)),
    globalRuntimeLayer(),
    (value, ctx) => renderGlobalStatusResult(value, globalStatusFormatFromInput(input), ctx),
  );
};

export const runMetaGlobalList = (): Promise<void> =>
  runCompiledCommand(
    globalList().pipe(Effect.provide(DefaultGlobalListLayer)),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    (value, ctx) => renderGlobalListResult(value, ctx),
  );

export const runMetaGlobalInfo = (argv: ReadonlyArray<string>): Promise<void> => {
  const input = compiledCommandInputFromArgv("meta:global:info", argv);
  return runCompiledCommand(
    globalInfo(globalInfoOptionsFromInput(input)),
    globalRuntimeLayer(),
    (value, ctx) => renderGlobalInfoResult(value, ctx),
  );
};

export const runMetaGlobalLogs = (argv: ReadonlyArray<string>): Promise<void> => {
  const input = compiledCommandInputFromArgv("meta:global:logs", argv);
  const options = globalLogsOptionsFromInput(input);
  if (globalLogsFollowFromInput(input)) {
    return runWithProcessAbortSignal((signal) =>
      runCompiledCommand(
        followGlobalLogs({ ...options, follow: true, signal }),
        globalRuntimeLayer(),
        renderGlobalLogsResult,
        { streamingMode: "live" },
      ),
    );
  }
  return runCompiledCommand(globalLogs(options), globalRuntimeLayer(), renderGlobalLogsResult);
};

export const runMetaGlobalRestart = (): Promise<void> =>
  runWithProcessAbortSignal((signal) =>
    runCompiledCommand(globalRestart({ signal }), globalRuntimeLayer(), renderGlobalRestartResult),
  );

export const runMetaGlobalRebuild = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("meta:global:rebuild", argv)) return Promise.resolve();
  return runWithProcessAbortSignal((signal) =>
    runCompiledCommand(globalRebuild({ signal }), globalRuntimeLayer(), renderGlobalRebuildResult),
  );
};

export const runMetaGlobalDestroy = (argv: ReadonlyArray<string>): Promise<void> => {
  const input = compiledCommandInputFromArgv("meta:global:destroy", argv);
  return runCompiledCommand(
    globalDestroy(globalDestroyOptionsFromInput(input)),
    globalRuntimeLayer(),
    renderGlobalDestroyResult,
  );
};

export const runMetaGlobalConfig = (argv: ReadonlyArray<string>): Promise<void> => {
  const input = compiledCommandInputFromArgv("meta:global:config", argv);
  return runCompiledCommand(
    globalConfig(globalConfigOptionsFromInput(input)),
    globalRuntimeLayer(),
    (value) => renderGlobalConfigResult(value, globalConfigFormatFromInput(input)),
  );
};

export const runMetaGlobalConfigVerb = (
  subcommand: "set" | "unset" | "edit" | "validate",
  argv: ReadonlyArray<string>,
): Promise<void> => {
  const input = compiledCommandInputFromArgv(`meta:global:config:${subcommand}`, argv);
  const options = { ...globalConfigOptionsFromInput(input), subcommand };
  return runCompiledCommand(globalConfig(options), globalRuntimeLayer(), (value) =>
    renderGlobalConfigResult(value, globalConfigFormatFromInput(input)),
  );
};

export const runMetaGlobalUninstall = (argv: ReadonlyArray<string>): Promise<void> => {
  const input = compiledCommandInputFromArgv("meta:global:uninstall", argv);
  return runCompiledCommand(
    globalUninstall(globalUninstallOptionsFromInput(input)),
    globalRuntimeLayer(),
    renderGlobalUninstallResult,
  );
};

export const runMetaUninstall = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("meta:uninstall", argv)) return Promise.resolve();
  const input = compiledCommandInputFromArgv("meta:uninstall", argv);
  return runCompiledCommand(
    uninstall({
      ...uninstallOptionsFromInput(input),
      execPath: process.execPath,
    }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderUninstallResult,
  );
};

export const runMetaMcp = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("meta:mcp", argv)) return Promise.resolve();
  const input = compiledCommandInputFromArgv("meta:mcp", argv);
  const registry = mcpRegistryFromCompiled(
    compiledCommands as Record<string, { readonly landoSpec?: LandoCommandSpec }>,
  );
  const flags = mcpFlagsFromParsed(input.flags);
  const commandRuntime = resolveCompiledCommandRuntime(
    "meta:mcp",
    "plugins",
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "plugins", plugins: { policy: "discovery" } })),
  ) as Layer.Layer<ConfigService | RedactionService, LandoRuntimeBootstrapError>;
  const retainedRuntime = makeLandoRuntime(
    cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } }),
  ).pipe(Layer.orDie) as Layer.Layer<unknown>;
  return dispatchMcpCommand({
    registry,
    flags,
    commandRuntime,
    retainedRuntime,
    rendererMode: activeRendererMode,
    resultFormat: activeResultFormat,
    invocation: getActiveCommandInvocation() ?? {
      commandId: "meta:mcp",
      argv: input.argv,
      args: input.args,
      flags: input.flags,
      cwd: process.cwd(),
    },
    formatError: (error) => commandErrorMessage(error, "meta:mcp"),
  });
};

export const runMetaGlobalInstall = (argv: ReadonlyArray<string>): Promise<void> => {
  const input = compiledCommandInputFromArgv("meta:global:install", argv);
  return runCompiledCommand(
    globalInstall(globalInstallOptionsFromInput(input)),
    globalRuntimeLayer(),
    renderGlobalInstallResult,
  );
};

export const runMetaBun = async (argv: ReadonlyArray<string>): Promise<void> => {
  const input = compiledCommandInputFromArgv("meta:bun", argv);
  await runCompiledCommand(metaBun({ argv: input.argv }), Layer.empty, renderMetaBunResult, {
    successExitCode: (result) => result.exitCode,
  });
};

export const runMetaX = async (argv: ReadonlyArray<string>): Promise<void> => {
  const input = compiledCommandInputFromArgv("meta:x", argv);
  const [spec, ...rest] = input.argv;
  if (spec === undefined) {
    emitDiagnosticLine("meta:x requires a package spec as the first positional argument.");
    process.exitCode = 1;
    return;
  }
  await runCompiledCommand(metaX({ spec, argv: rest }), Layer.empty, renderMetaXResult, {
    successExitCode: (result) => result.exitCode,
  });
};

export const runMetaPluginAdd = async (argv: ReadonlyArray<string>): Promise<void> => {
  const trust = argv.includes("--trust") || argv.includes("--yes") || argv.includes("-y");
  const spec = argv.find((arg) => !arg.startsWith("-"));
  if (spec === undefined) {
    emitDiagnosticLine(
      commandErrorMessage(
        new NotImplementedError({
          message: "meta:plugin:add requires a plugin spec argument.",
          commandId: "meta:plugin:add",
          remediation: "Pass an npm package spec, e.g. `lando plugin:add @lando/plugin-php`.",
        }),
      ),
    );
    process.exitCode = 1;
    return;
  }
  await runCompiledCommand(
    pluginAdd({ spec, trust, nonInteractive: resolveNonInteractive({ isTTY: process.stdin.isTTY }) }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderPluginAddResult,
  );
};

export const runMetaPluginNew = async (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("meta:plugin:new", argv)) return;
  const input = compiledCommandInputFromArgv("meta:plugin:new", argv);
  const answerFlag = input.flags.answer;
  await runCompiledCommand(
    pluginNew({
      name: typeof input.args.name === "string" ? input.args.name : undefined,
      destination: typeof input.args.destination === "string" ? input.args.destination : undefined,
      template: typeof input.flags.template === "string" ? input.flags.template : undefined,
      cspace: typeof input.flags.cspace === "string" ? input.flags.cspace : undefined,
      description: typeof input.flags.description === "string" ? input.flags.description : undefined,
      answers:
        Array.isArray(answerFlag) && answerFlag.every((entry) => typeof entry === "string")
          ? answerFlag
          : undefined,
      answersFile: typeof input.flags.answers === "string" ? input.flags.answers : undefined,
      nonInteractive: resolveNonInteractive({
        noInteractive: input.flags["no-interactive"] === true,
        isTTY: process.stdin.isTTY,
      }),
    }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderPluginNewResult,
  );
};

export const runMetaPluginTest = async (argv: ReadonlyArray<string>): Promise<void> => {
  const dashIndex = argv.indexOf("--");
  const preDash = dashIndex === -1 ? argv : argv.slice(0, dashIndex);
  const unknownFlag = preDash.find((arg) => arg.startsWith("-") && arg !== "-");
  if (unknownFlag !== undefined) {
    const equalsIndex = unknownFlag.indexOf("=");
    emitDiagnosticLine(
      `Nonexistent flag: ${equalsIndex === -1 ? unknownFlag : unknownFlag.slice(0, equalsIndex)}`,
    );
    process.exitCode = 2;
    return;
  }
  await runCompiledCommand(
    pluginTest({ argv }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderPluginTestResult,
  );
};

export const runMetaPluginBuild = async (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("meta:plugin:build", argv)) return;
  await runCompiledCommand(
    pluginBuild(),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderPluginBuildResult,
  );
};

const metaPluginPublishCommandId = "meta:plugin:publish";

const parsePluginPublish = (argv: ReadonlyArray<string>): PluginPublishOptions => {
  const { flags } = compiledCommandInputFromArgv(metaPluginPublishCommandId, argv);
  return {
    ...(typeof flags.tag === "string" ? { tag: flags.tag } : {}),
    ...(typeof flags.registry === "string" ? { registry: flags.registry } : {}),
    dryRun: flags["dry-run"] === true,
    noTest: flags["no-test"] === true,
    nonInteractive: resolveNonInteractive({
      noInteractive: flags["no-interactive"] === true,
      isTTY: process.stdin.isTTY,
    }),
  };
};

export const runMetaPluginPublish = async (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation(metaPluginPublishCommandId, argv)) return;
  await runCompiledCommand(
    pluginPublish(parsePluginPublish(argv)),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderPluginPublishResult,
  );
};

export const runMetaPluginLink = async (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("meta:plugin:link", argv)) return;
  const input = compiledCommandInputFromArgv("meta:plugin:link", argv);
  const options = typeof input.args.path === "string" ? { path: input.args.path } : {};
  await runCompiledCommand(
    pluginLink(options),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderPluginLinkResult,
  );
};

const metaPluginUnlinkCommandId = "meta:plugin:unlink";

export const runMetaPluginUnlink = async (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation(metaPluginUnlinkCommandId, argv)) return;
  const input = compiledCommandInputFromArgv(metaPluginUnlinkCommandId, argv);
  const name = typeof input.args.name === "string" ? input.args.name : undefined;
  if (name === undefined) {
    emitDiagnosticLine("Missing 1 required arg:\nname  Plugin name.");
    process.exitCode = 2;
    return;
  }
  await runCompiledCommand(
    pluginUnlink({ name }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderPluginUnlinkResult,
  );
};

export const runMetaPluginRemove = async (argv: ReadonlyArray<string>): Promise<void> => {
  const name = argv.find((arg) => !arg.startsWith("-"));
  if (name === undefined) {
    emitDiagnosticLine(
      commandErrorMessage(
        new NotImplementedError({
          message: "meta:plugin:remove requires a plugin name argument.",
          commandId: "meta:plugin:remove",
          remediation: "Pass the plugin name, e.g. `lando plugin:remove @lando/plugin-php`.",
        }),
      ),
    );
    process.exitCode = 1;
    return;
  }
  await runCompiledCommand(
    pluginRemove({ name }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderPluginRemoveResult,
  );
};

export const runMetaPluginTrust = async (argv: ReadonlyArray<string>): Promise<void> => {
  const action = argv.find((arg) => !arg.startsWith("-"));
  if (action === "list") {
    await runCompiledCommand(
      pluginTrustList(),
      makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
      renderPluginTrustListResult,
    );
    return;
  }
  if (action === "revoke") {
    const name = argv.slice(argv.indexOf(action) + 1).find((arg) => !arg.startsWith("-"));
    if (name === undefined) {
      emitDiagnosticLine(
        commandErrorMessage(
          new NotImplementedError({
            message: "meta:plugin:trust revoke requires a plugin name argument.",
            commandId: "meta:plugin:trust",
            remediation: "Pass the plugin name, e.g. `lando plugin:trust revoke @lando/plugin-php`.",
          }),
        ),
      );
      process.exitCode = 1;
      return;
    }
    await runCompiledCommand(
      pluginTrustRevoke({ name }),
      makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
      renderPluginTrustRevokeResult,
    );
    return;
  }
  const name = action;
  if (name === undefined) {
    emitDiagnosticLine(
      commandErrorMessage(
        new NotImplementedError({
          message: "meta:plugin:trust requires a plugin name argument.",
          commandId: "meta:plugin:trust",
          remediation: "Pass the plugin name, e.g. `lando plugin:trust @lando/plugin-php`.",
        }),
      ),
    );
    process.exitCode = 1;
    return;
  }
  await runCompiledCommand(
    pluginTrust({ name }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderPluginTrustResult,
  );
};

export const runMetaPluginTrustAuthoringRoot = async (argv: ReadonlyArray<string>): Promise<void> => {
  const path = argv.find((arg) => !arg.startsWith("-"));
  if (path === undefined) {
    emitDiagnosticLine(
      commandErrorMessage(
        new NotImplementedError({
          message: "meta:plugin:trust-authoring-root requires an absolute path argument.",
          commandId: "meta:plugin:trust-authoring-root",
          remediation: "Pass an absolute path, e.g. `lando plugin:trust-authoring-root /home/me/plugin`.",
        }),
      ),
    );
    process.exitCode = 1;
    return;
  }
  await runCompiledCommand(
    pluginTrustAuthoringRoot({ path }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderPluginTrustAuthoringRootResult,
  );
};

export const buildCanonicalCommandIdByToken = (): Readonly<Record<string, string>> => {
  const entries: Array<[string, string]> = [];
  for (const [id, command] of commandEntries) {
    const spec = (command as { readonly landoSpec?: { readonly id?: string } }).landoSpec;
    const canonicalId = spec?.id ?? id;
    entries.push([id, canonicalId]);
    for (const alias of command.aliases ?? []) entries.push([alias, canonicalId]);
  }
  for (const [id, command] of Object.entries(compiledManifest.commands)) {
    const spec = (command as { readonly landoSpec?: { readonly id?: string } }).landoSpec;
    const canonicalId = spec?.id ?? id;
    entries.push([id, canonicalId]);
    for (const alias of command.aliases ?? []) entries.push([alias, canonicalId]);
    for (const alias of command.aliasPermutations ?? []) entries.push([alias, canonicalId]);
    for (const permutation of command.permutations ?? []) entries.push([permutation, canonicalId]);
  }
  return Object.fromEntries(entries);
};

export const CANONICAL_COMMAND_ID_BY_TOKEN = buildCanonicalCommandIdByToken();

export const resolveCanonicalCommandId = (token: string | undefined): string => {
  if (token === undefined) return "cli:unknown";
  return CANONICAL_COMMAND_ID_BY_TOKEN[token] ?? token;
};

export const runMetaVersion = async (): Promise<void> => {
  setActiveCommandId("meta:version");
  resetActiveCommandInvocation("meta:version", []);
  await runCompiledCommand(
    versionOperation,
    Layer.empty,
    (result) => `@lando/core ${result.core} (bun ${result.bun} on ${result.platform})`,
  );
};

export const runMetaRecipesList = (): Promise<void> =>
  runCompiledCommand(recipesList, Layer.empty, (value) => renderRecipesListResult(value));

export const runMetaRecipesDescribe = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("meta:recipes:describe", argv)) return Promise.resolve();
  const input = compiledCommandInputFromArgv("meta:recipes:describe", argv);
  const ref = recipeRefFromInput(input);
  if (ref === "") {
    emitDiagnosticLine("Missing required argument: ref");
    process.exitCode = 2;
    return Promise.resolve();
  }
  return runCompiledCommand(recipesDescribe(ref, { cwd: process.cwd() }), Layer.empty, (value) =>
    renderRecipesDescribeResult(value),
  );
};

export const runMetaRecipesValidate = (argv: ReadonlyArray<string>): Promise<void> => {
  if (rejectInvalidInvocation("meta:recipes:validate", argv)) return Promise.resolve();
  const input = compiledCommandInputFromArgv("meta:recipes:validate", argv);
  const path = recipePathFromInput(input);
  if (path === "") {
    emitDiagnosticLine("Missing required argument: path");
    process.exitCode = 2;
    return Promise.resolve();
  }
  return runCompiledCommand(recipesValidate(path, { cwd: process.cwd() }), Layer.empty, (value) =>
    renderRecipesValidateResult(value),
  );
};

const SHELLENV_SHELLS = ["posix", "powershell", "pwsh"] as const;

export const runMetaShellenv = async (argv: ReadonlyArray<string> = []): Promise<void> => {
  if (rejectInvalidInvocation("meta:shellenv", argv)) return;
  const input = compiledCommandInputFromArgv("meta:shellenv", argv);
  const shell = input.flags.shell;
  if (argv.includes("--shell") && shell === undefined) {
    emitDiagnosticLine("Flag --shell expects one of these values: posix, powershell, pwsh");
    process.exitCode = 2;
    return;
  }
  if (shell !== undefined && !SHELLENV_SHELLS.includes(shell as (typeof SHELLENV_SHELLS)[number])) {
    emitDiagnosticLine(`Expected --shell=${shell} to be one of: posix, powershell, pwsh`);
    process.exitCode = 2;
    return;
  }
  await runCompiledCommand(Effect.succeed(shellenvShellFromInput(input)), Layer.empty, (value) =>
    renderShellenv(value),
  );
};
