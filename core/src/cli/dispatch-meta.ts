/**
 * Compiled-CLI dispatch for `meta:*` topic commands: host setup/doctor, config,
 * version, recipes, shellenv, uninstall, mcp, update, the global-service
 * lifecycle, `bun`/`x` passthroughs, and plugin management.
 *
 * Returns `false` when the argv does not belong to this topic so `runCompiledCli`
 * can fall through to its not-implemented / not-found handling.
 */
import { cliRuntimeOptions } from "../runtime/cli-options.ts";
import { makeLandoRuntime } from "../runtime/layer.ts";
import { runDoctor, runSetup } from "./cli-adapters/app-lifecycle.ts";
import {
  runMetaBun,
  runMetaGlobalConfig,
  runMetaGlobalConfigVerb,
  runMetaGlobalDestroy,
  runMetaGlobalInfo,
  runMetaGlobalInstall,
  runMetaGlobalList,
  runMetaGlobalLogs,
  runMetaGlobalRebuild,
  runMetaGlobalRestart,
  runMetaGlobalStart,
  runMetaGlobalStatus,
  runMetaGlobalStop,
  runMetaGlobalUninstall,
  runMetaMcp,
  runMetaPluginAdd,
  runMetaPluginBuild,
  runMetaPluginLink,
  runMetaPluginNew,
  runMetaPluginPublish,
  runMetaPluginRemove,
  runMetaPluginTest,
  runMetaPluginTrust,
  runMetaPluginTrustAuthoringRoot,
  runMetaPluginUnlink,
  runMetaRecipesDescribe,
  runMetaRecipesList,
  runMetaRecipesValidate,
  runMetaShellenv,
  runMetaUninstall,
  runMetaVersion,
  runMetaX,
} from "./cli-adapters/meta-plugin.ts";
import { config, renderConfigResult } from "./commands/config.ts";
import { update } from "./commands/update.ts";
import { compiledCommandInputFromArgv } from "./compiled-input.ts";
import { rejectInvalidInvocation, runCompiledCommand } from "./compiled-runtime.ts";
import { metaConfigOptionsFromInput } from "./oclif/commands/meta/config.ts";
import { updateOptionsFromInput } from "./oclif/commands/meta/update.ts";

const runMetaConfig = async (argv: ReadonlyArray<string>): Promise<void> => {
  const input = compiledCommandInputFromArgv("meta:config", argv);
  const options = metaConfigOptionsFromInput(input);
  return runCompiledCommand(
    config(options),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
    renderConfigResult,
  );
};

export const dispatchMetaCommand = async (argv: ReadonlyArray<string>): Promise<boolean> => {
  if (argv[0] === "setup" || argv[0] === "meta:setup") {
    await runSetup(argv.slice(1));
    return true;
  }

  if (argv[0] === "doctor" || argv[0] === "meta:doctor") {
    await runDoctor(argv.slice(1));
    return true;
  }

  if (argv[0] === "config" || argv[0] === "meta:config") {
    await runMetaConfig(argv.slice(1));
    return true;
  }

  if (argv[0] === "version" || argv[0] === "meta:version") {
    await runMetaVersion();
    return true;
  }

  if (argv[0] === "recipes" || argv[0] === "meta:recipes:list") {
    if (rejectInvalidInvocation("meta:recipes:list", argv.slice(1))) return true;
    await runMetaRecipesList();
    return true;
  }

  if (argv[0] === "meta:recipes:describe") {
    await runMetaRecipesDescribe(argv.slice(1));
    return true;
  }

  if (argv[0] === "meta:recipes:validate") {
    await runMetaRecipesValidate(argv.slice(1));
    return true;
  }

  if (argv[0] === "shellenv" || argv[0] === "meta:shellenv") {
    await runMetaShellenv(argv.slice(1));
    return true;
  }

  if (argv[0] === "uninstall" || argv[0] === "meta:uninstall") {
    await runMetaUninstall(argv.slice(1));
    return true;
  }

  if (argv[0] === "mcp" || argv[0] === "meta:mcp") {
    await runMetaMcp(argv.slice(1));
    return true;
  }

  if (argv[0] === "update" || argv[0] === "meta:update") {
    if (rejectInvalidInvocation("meta:update", argv.slice(1))) return true;
    const input = compiledCommandInputFromArgv("meta:update", argv.slice(1));
    await runCompiledCommand(
      update(updateOptionsFromInput(input)),
      makeLandoRuntime(cliRuntimeOptions({ bootstrap: "plugins", plugins: { policy: "discovery" } })),
      () => undefined,
    );
    return true;
  }

  if (argv[0] === "global:config:set" || argv[0] === "meta:global:config:set") {
    await runMetaGlobalConfigVerb("set", argv.slice(1));
    return true;
  }

  if (argv[0] === "global:config:unset" || argv[0] === "meta:global:config:unset") {
    await runMetaGlobalConfigVerb("unset", argv.slice(1));
    return true;
  }

  if (argv[0] === "global:config:edit" || argv[0] === "meta:global:config:edit") {
    await runMetaGlobalConfigVerb("edit", argv.slice(1));
    return true;
  }

  if (argv[0] === "global:config:validate" || argv[0] === "meta:global:config:validate") {
    await runMetaGlobalConfigVerb("validate", argv.slice(1));
    return true;
  }

  if (argv[0] === "global:config" || argv[0] === "meta:global:config") {
    await runMetaGlobalConfig(argv.slice(1));
    return true;
  }

  if (argv[0] === "global:destroy" || argv[0] === "meta:global:destroy") {
    await runMetaGlobalDestroy(argv.slice(1));
    return true;
  }

  if (argv[0] === "global:install" || argv[0] === "meta:global:install") {
    await runMetaGlobalInstall(argv.slice(1));
    return true;
  }

  if (argv[0] === "global:info" || argv[0] === "meta:global:info") {
    await runMetaGlobalInfo(argv.slice(1));
    return true;
  }

  if (argv[0] === "global:list" || argv[0] === "meta:global:list") {
    await runMetaGlobalList();
    return true;
  }

  if (argv[0] === "global:logs" || argv[0] === "meta:global:logs") {
    await runMetaGlobalLogs(argv.slice(1));
    return true;
  }

  if (argv[0] === "global:rebuild" || argv[0] === "meta:global:rebuild") {
    await runMetaGlobalRebuild(argv.slice(1));
    return true;
  }

  if (argv[0] === "global:restart" || argv[0] === "meta:global:restart") {
    await runMetaGlobalRestart();
    return true;
  }

  if (argv[0] === "global:start" || argv[0] === "meta:global:start") {
    await runMetaGlobalStart(argv.slice(1));
    return true;
  }

  if (argv[0] === "global:status" || argv[0] === "meta:global:status") {
    await runMetaGlobalStatus(argv.slice(1));
    return true;
  }

  if (argv[0] === "global:stop" || argv[0] === "meta:global:stop") {
    await runMetaGlobalStop();
    return true;
  }

  if (argv[0] === "global:uninstall" || argv[0] === "meta:global:uninstall") {
    await runMetaGlobalUninstall(argv.slice(1));
    return true;
  }

  if (argv[0] === "bun" || argv[0] === "meta:bun") {
    await runMetaBun(argv.slice(1));
    return true;
  }

  if (argv[0] === "x" || argv[0] === "meta:x") {
    await runMetaX(argv.slice(1));
    return true;
  }

  if (argv[0] === "plugin:add" || argv[0] === "meta:plugin:add") {
    await runMetaPluginAdd(argv.slice(1));
    return true;
  }

  if (argv[0] === "meta:plugin:new") {
    await runMetaPluginNew(argv.slice(1));
    return true;
  }

  if (argv[0] === "meta:plugin:test") {
    await runMetaPluginTest(argv.slice(1));
    return true;
  }

  if (argv[0] === "meta:plugin:build") {
    await runMetaPluginBuild(argv.slice(1));
    return true;
  }

  if (argv[0] === "meta:plugin:publish") {
    await runMetaPluginPublish(argv.slice(1));
    return true;
  }

  if (argv[0] === "meta:plugin:link") {
    await runMetaPluginLink(argv.slice(1));
    return true;
  }

  if (argv[0] === "meta:plugin:unlink") {
    await runMetaPluginUnlink(argv.slice(1));
    return true;
  }

  if (argv[0] === "plugin:remove" || argv[0] === "meta:plugin:remove") {
    await runMetaPluginRemove(argv.slice(1));
    return true;
  }

  if (argv[0] === "plugin:trust" || argv[0] === "meta:plugin:trust") {
    await runMetaPluginTrust(argv.slice(1));
    return true;
  }

  if (argv[0] === "plugin:trust-authoring-root" || argv[0] === "meta:plugin:trust-authoring-root") {
    await runMetaPluginTrustAuthoringRoot(argv.slice(1));
    return true;
  }

  return false;
};
