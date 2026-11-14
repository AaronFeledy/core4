import { bundledPluginModules } from "@lando/engine/composition";
import { uninstall } from "@lando/engine/operations/uninstall";
import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { makeHostMaintenanceRegistryLayer } from "@lando/engine/runtime/host-maintenance";
import * as HostPrivilegeService from "@lando/engine/services/privilege";
import type { RedactionService } from "@lando/redaction/service";
import type { ConfigError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import type { ConfigService } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Layer } from "effect";
import { type CliInvocationContext, processInvocationContext } from "../../runtime/invocation-context";
import { makeLandoGenerationRuntime, makeLandoRuntime } from "../../runtime/layer";
import type { BuiltInCommandCatalog } from "../built-in-command-catalog-service";
import { shellenvSpec } from "../command-specs/meta/shellenv";
import { uninstallOptionsFromInput } from "../command-specs/meta/uninstall";
import { dispatchMcpCommand, mcpFlagsFromParsed } from "../commands/meta/mcp";
import { renderUninstallResult } from "../commands/uninstall";
import { version as versionOperation } from "../commands/version";
import { compiledCommandInputFromArgv } from "../compiled-input";
import {
  activeRendererMode,
  activeResultFormat,
  commandErrorMessage,
  emitDiagnosticLine,
  getActiveCommandInvocation,
  rejectInvalidInvocation,
  resetActiveCommandInvocation,
  resolveCompiledCommandRuntime,
  runCompiledCommand,
  setActiveCommandId,
} from "../compiled-runtime";
import type { CommandTokens } from "../invocation";
import { readCliAppCommandCache } from "../tooling-command-cache";

export const runMetaUninstall = async (
  tokens: CommandTokens,
  signal?: AbortSignal,
  context: CliInvocationContext = processInvocationContext(),
): Promise<void> => {
  if (await rejectInvalidInvocation("meta:uninstall", tokens.argv, context)) return;
  const input = compiledCommandInputFromArgv("meta:uninstall", tokens.argv, { tokens, context });
  return runCompiledCommand(
    uninstall(uninstallOptionsFromInput(input)),
    Layer.mergeAll(
      PrivateFileAccessService.layer,
      HostPrivilegeService.layer,
      makeHostMaintenanceRegistryLayer(bundledPluginModules()),
    ),
    (value, renderContext) => renderUninstallResult(value, renderContext, context.setExitCode),
    { context, ...(signal === undefined ? {} : { signal }) },
  );
};

export const runMetaMcp = async (
  tokens: CommandTokens,
  signal?: AbortSignal,
  context: CliInvocationContext = processInvocationContext(),
): Promise<void> => {
  if (await rejectInvalidInvocation("meta:mcp", tokens.argv, context)) return;
  const input = compiledCommandInputFromArgv("meta:mcp", tokens.argv, { tokens, context });
  const flags = mcpFlagsFromParsed(input.flags);
  const commandRuntime = resolveCompiledCommandRuntime(
    "meta:mcp",
    "plugins",
    makeLandoRuntime(
      cliRuntimeOptions({ bootstrap: "plugins", plugins: { policy: "discovery" } }, context.env),
    ),
  ) as Layer.Layer<
    ConfigService | RedactionService | BuiltInCommandCatalog,
    ConfigError | LandoRuntimeBootstrapError
  >;
  const sessionRuntime = makeLandoGenerationRuntime(
    cliRuntimeOptions(
      { bootstrap: "app", plugins: { policy: "discovery" }, interaction: "non-interactive" },
      context.env,
    ),
    context,
  );
  return dispatchMcpCommand({
    context,
    flags,
    ...(signal === undefined ? {} : { signal }),
    commandRuntime,
    sessionRuntime,
    // Session start rebuilds a non-fresh index silently (stdout is the protocol); a failed
    // rebuild keeps the registry's own fallback so the server still starts.
    prepareTooling: Effect.ignore(
      readCliAppCommandCache({ includeScriptInventory: true, rebuildNotice: false }),
    ),
    rendererMode: activeRendererMode,
    resultFormat: activeResultFormat,
    invocation: getActiveCommandInvocation() ?? {
      commandId: "meta:mcp",
      argv: input.argv,
      args: input.args,
      flags: input.flags,
      cwd: context.cwd,
    },
    formatError: (failure, redactor) => commandErrorMessage(failure, "meta:mcp", redactor, context.env),
  });
};

export const runMetaVersion = async (context?: CliInvocationContext): Promise<void> => {
  setActiveCommandId("meta:version");
  resetActiveCommandInvocation("meta:version", [], { ...(context === undefined ? {} : { context }) });
  await runCompiledCommand(versionOperation, Layer.empty, (result) => result.core, {
    ...(context === undefined ? {} : { context }),
  });
};

const SHELLENV_SHELLS = ["posix", "powershell", "pwsh"] as const;

export const runMetaShellenv = async (
  tokens: CommandTokens,
  signal?: AbortSignal,
  context: CliInvocationContext = processInvocationContext(),
): Promise<void> => {
  if (await rejectInvalidInvocation("meta:shellenv", tokens.argv, context)) return;
  const input = compiledCommandInputFromArgv("meta:shellenv", tokens.argv, { tokens, context });
  const shell = input.flags.shell;
  if (tokens.argv.includes("--shell") && shell === undefined) {
    await emitDiagnosticLine("Flag --shell expects one of these values: posix, powershell, pwsh", context);
    context.setExitCode(2);
    return;
  }
  if (shell !== undefined && !SHELLENV_SHELLS.includes(shell as (typeof SHELLENV_SHELLS)[number])) {
    await emitDiagnosticLine(`Expected --shell=${shell} to be one of: posix, powershell, pwsh`, context);
    context.setExitCode(2);
    return;
  }
  await runCompiledCommand(shellenvSpec.run(input), Layer.empty, (value) => value, {
    context,
    ...(signal === undefined ? {} : { signal }),
  });
};
