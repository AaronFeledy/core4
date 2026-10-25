import { Layer } from "effect";

import type { RedactionService } from "@lando/redaction/service";
import type { ConfigError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import type { ConfigService } from "@lando/sdk/services";

import { bundledPluginModules } from "@lando/engine/composition";
import { uninstall } from "@lando/engine/operations/uninstall";
import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { makeHostMaintenanceRegistryLayer } from "@lando/engine/runtime/host-maintenance";
import * as HostPrivilegeService from "@lando/engine/services/privilege";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { makeLandoRuntime } from "../../runtime/layer";
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

export const runMetaUninstall = async (argv: ReadonlyArray<string>): Promise<void> => {
  if (await rejectInvalidInvocation("meta:uninstall", argv)) return;
  const input = compiledCommandInputFromArgv("meta:uninstall", argv);
  return runCompiledCommand(
    uninstall(uninstallOptionsFromInput(input)),
    Layer.mergeAll(
      PrivateFileAccessService.layer,
      HostPrivilegeService.layer,
      makeHostMaintenanceRegistryLayer(bundledPluginModules()),
    ),
    renderUninstallResult,
  );
};

export const runMetaMcp = async (argv: ReadonlyArray<string>, signal?: AbortSignal): Promise<void> => {
  if (await rejectInvalidInvocation("meta:mcp", argv)) return;
  const input = compiledCommandInputFromArgv("meta:mcp", argv);
  const flags = mcpFlagsFromParsed(input.flags);
  const commandRuntime = resolveCompiledCommandRuntime(
    "meta:mcp",
    "plugins",
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "plugins", plugins: { policy: "discovery" } })),
  ) as Layer.Layer<
    ConfigService | RedactionService | BuiltInCommandCatalog,
    ConfigError | LandoRuntimeBootstrapError
  >;
  const retainedRuntime = makeLandoRuntime(
    cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } }),
  ).pipe(Layer.orDie) as Layer.Layer<unknown>;
  return dispatchMcpCommand({
    flags,
    ...(signal === undefined ? {} : { signal }),
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
    formatError: (failure) => commandErrorMessage(failure, "meta:mcp"),
  });
};

export const runMetaVersion = async (): Promise<void> => {
  setActiveCommandId("meta:version");
  resetActiveCommandInvocation("meta:version", []);
  await runCompiledCommand(versionOperation, Layer.empty, (result) => result.core);
};

const SHELLENV_SHELLS = ["posix", "powershell", "pwsh"] as const;

export const runMetaShellenv = async (argv: ReadonlyArray<string> = []): Promise<void> => {
  if (await rejectInvalidInvocation("meta:shellenv", argv)) return;
  const input = compiledCommandInputFromArgv("meta:shellenv", argv);
  const shell = input.flags.shell;
  if (argv.includes("--shell") && shell === undefined) {
    await emitDiagnosticLine("Flag --shell expects one of these values: posix, powershell, pwsh");
    process.exitCode = 2;
    return;
  }
  if (shell !== undefined && !SHELLENV_SHELLS.includes(shell as (typeof SHELLENV_SHELLS)[number])) {
    await emitDiagnosticLine(`Expected --shell=${shell} to be one of: posix, powershell, pwsh`);
    process.exitCode = 2;
    return;
  }
  await runCompiledCommand(shellenvSpec.run(input), Layer.empty, (value) => value);
};
