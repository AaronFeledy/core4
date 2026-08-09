import { NotImplementedError } from "@lando/sdk/errors";

import type { BootstrapLevel } from "@lando/engine/runtime/bootstrap";
import { buildBuiltInCommandIndex } from "./built-in-command-index";
import { mcpRegistryFromBuiltIns } from "./commands/meta/mcp";
import { type DeferredCommandPlan, notImplementedErrorForSpec } from "./deferred-commands";
import AppCacheRefreshCommand from "./oclif/commands/app/cache/refresh";
import AppConfigCommand from "./oclif/commands/app/config/index";
import AppConfigLintCommand from "./oclif/commands/app/config/lint";
import AppConfigTranslateCommand from "./oclif/commands/app/config/translate";
import {
  AppConfigEditCommand,
  AppConfigSetCommand,
  AppConfigUnsetCommand,
  AppConfigValidateCommand,
} from "./oclif/commands/app/config/verbs";
import DestroyCommand from "./oclif/commands/app/destroy";
import ExecCommand from "./oclif/commands/app/exec";
import AppIncludesUpdateCommand from "./oclif/commands/app/includes/update";
import AppIncludesVerifyCommand from "./oclif/commands/app/includes/verify";
import InfoCommand from "./oclif/commands/app/info";
import LogsCommand from "./oclif/commands/app/logs";
import OpenCommand from "./oclif/commands/app/open";
import PullCommand from "./oclif/commands/app/pull";
import PushCommand from "./oclif/commands/app/push";
import RebuildCommand from "./oclif/commands/app/rebuild";
import RemoteAddCommand from "./oclif/commands/app/remote/add";
import RemoteEnvListCommand from "./oclif/commands/app/remote/env/list";
import RemoteListCommand from "./oclif/commands/app/remote/list";
import RemoteRemoveCommand from "./oclif/commands/app/remote/remove";
import RemoteSetupCommand from "./oclif/commands/app/remote/setup";
import RemoteTestCommand from "./oclif/commands/app/remote/test";
import RestartCommand from "./oclif/commands/app/restart";
import ShareCommand from "./oclif/commands/app/share";
import ShareListCommand from "./oclif/commands/app/share/list";
import ShareStopCommand from "./oclif/commands/app/share/stop";
import ShellCommand from "./oclif/commands/app/shell";
import SshCommand from "./oclif/commands/app/ssh";
import StartCommand from "./oclif/commands/app/start";
import StopCommand from "./oclif/commands/app/stop";
import InitCommand from "./oclif/commands/apps/init";
import ListCommand from "./oclif/commands/apps/list";
import PoweroffCommand from "./oclif/commands/apps/poweroff";
import AppsScratchDestroyCommand from "./oclif/commands/apps/scratch/destroy";
import AppsScratchGcCommand from "./oclif/commands/apps/scratch/gc";
import AppsScratchInfoCommand from "./oclif/commands/apps/scratch/info";
import AppsScratchListCommand from "./oclif/commands/apps/scratch/list";
import AppsScratchLogsCommand from "./oclif/commands/apps/scratch/logs";
import AppsScratchRunCommand from "./oclif/commands/apps/scratch/run";
import AppsScratchStartCommand from "./oclif/commands/apps/scratch/start";
import AppsScratchStopCommand from "./oclif/commands/apps/scratch/stop";
import BunCommand from "./oclif/commands/meta/bun";
import MetaConfigCommand from "./oclif/commands/meta/config";
import DoctorCommand from "./oclif/commands/meta/doctor";
import EventsFollowCommand from "./oclif/commands/meta/events/follow";
import MetaGlobalConfigCommand from "./oclif/commands/meta/global/config";
import {
  MetaGlobalConfigEditCommand,
  MetaGlobalConfigSetCommand,
  MetaGlobalConfigUnsetCommand,
  MetaGlobalConfigValidateCommand,
} from "./oclif/commands/meta/global/config-verbs";
import MetaGlobalDestroyCommand from "./oclif/commands/meta/global/destroy";
import MetaGlobalInfoCommand from "./oclif/commands/meta/global/info";
import MetaGlobalInstallCommand from "./oclif/commands/meta/global/install";
import MetaGlobalListCommand from "./oclif/commands/meta/global/list";
import MetaGlobalLogsCommand from "./oclif/commands/meta/global/logs";
import MetaGlobalRebuildCommand from "./oclif/commands/meta/global/rebuild";
import MetaGlobalRestartCommand from "./oclif/commands/meta/global/restart";
import MetaGlobalStartCommand from "./oclif/commands/meta/global/start";
import MetaGlobalStatusCommand from "./oclif/commands/meta/global/status";
import MetaGlobalStopCommand from "./oclif/commands/meta/global/stop";
import MetaGlobalUninstallCommand from "./oclif/commands/meta/global/uninstall";
import MetaMcpCommand, { injectMcpCommandRegistry } from "./oclif/commands/meta/mcp";
import PluginAddCommand from "./oclif/commands/meta/plugin/add";
import PluginBuildCommand from "./oclif/commands/meta/plugin/build";
import PluginLinkCommand from "./oclif/commands/meta/plugin/link";
import PluginLoginCommand from "./oclif/commands/meta/plugin/login";
import PluginLogoutCommand from "./oclif/commands/meta/plugin/logout";
import PluginNewCommand from "./oclif/commands/meta/plugin/new";
import PluginPublishCommand from "./oclif/commands/meta/plugin/publish";
import PluginRemoveCommand from "./oclif/commands/meta/plugin/remove";
import PluginTestCommand from "./oclif/commands/meta/plugin/test";
import PluginTrustCommand from "./oclif/commands/meta/plugin/trust";
import PluginTrustAuthoringRootCommand from "./oclif/commands/meta/plugin/trust-authoring-root";
import PluginUnlinkCommand from "./oclif/commands/meta/plugin/unlink";
import RecipesDescribeCommand from "./oclif/commands/meta/recipes/describe";
import RecipesListCommand from "./oclif/commands/meta/recipes/list";
import RecipesValidateCommand from "./oclif/commands/meta/recipes/validate";
import SetupCommand from "./oclif/commands/meta/setup";
import ShellenvCommand from "./oclif/commands/meta/shellenv";
import UninstallCommand from "./oclif/commands/meta/uninstall";
import UpdateCommand from "./oclif/commands/meta/update";
import VersionCommand from "./oclif/commands/meta/version";
import XCommand from "./oclif/commands/meta/x";
import type { LandoCommandSpec } from "./spec/command-base";
import type { CommandClass } from "./spec/metadata";

export { buildBuiltInCommandIndex } from "./built-in-command-index";

export type BuiltInCommandClass = CommandClass & {
  readonly landoSpec: LandoCommandSpec;
  readonly bootstrap: BootstrapLevel;
};

export type BuiltInCommandStatus =
  | { readonly kind: "implemented" }
  | { readonly kind: "deferred"; readonly plan: DeferredCommandPlan };

export type BuiltInCommandEntry = {
  readonly command: BuiltInCommandClass;
  readonly spec: LandoCommandSpec;
  readonly status: BuiltInCommandStatus;
};

const registered = (command: BuiltInCommandClass): BuiltInCommandEntry => {
  const plan = command.landoSpec.deferred;
  return {
    command,
    spec: command.landoSpec,
    status: plan === undefined ? { kind: "implemented" } : { kind: "deferred", plan },
  };
};

export const builtInCommandRegistry = {
  "app:cache:refresh": registered(AppCacheRefreshCommand),
  "app:config": registered(AppConfigCommand),
  "app:config:lint": registered(AppConfigLintCommand),
  "app:config:translate": registered(AppConfigTranslateCommand),
  "app:config:set": registered(AppConfigSetCommand),
  "app:config:unset": registered(AppConfigUnsetCommand),
  "app:config:edit": registered(AppConfigEditCommand),
  "app:config:validate": registered(AppConfigValidateCommand),
  "app:destroy": registered(DestroyCommand),
  "app:exec": registered(ExecCommand),
  "app:includes:update": registered(AppIncludesUpdateCommand),
  "app:includes:verify": registered(AppIncludesVerifyCommand),
  "app:info": registered(InfoCommand),
  "app:logs": registered(LogsCommand),
  "app:open": registered(OpenCommand),
  "app:pull": registered(PullCommand),
  "app:push": registered(PushCommand),
  "app:remote:add": registered(RemoteAddCommand),
  "app:remote:env:list": registered(RemoteEnvListCommand),
  "app:remote:list": registered(RemoteListCommand),
  "app:remote:remove": registered(RemoteRemoveCommand),
  "app:remote:setup": registered(RemoteSetupCommand),
  "app:remote:test": registered(RemoteTestCommand),
  "app:share": registered(ShareCommand),
  "app:share:list": registered(ShareListCommand),
  "app:share:stop": registered(ShareStopCommand),
  "app:rebuild": registered(RebuildCommand),
  "app:restart": registered(RestartCommand),
  "app:shell": registered(ShellCommand),
  "app:ssh": registered(SshCommand),
  "app:start": registered(StartCommand),
  "app:stop": registered(StopCommand),
  "apps:init": registered(InitCommand),
  "apps:list": registered(ListCommand),
  "apps:poweroff": registered(PoweroffCommand),
  "apps:scratch:destroy": registered(AppsScratchDestroyCommand),
  "apps:scratch:gc": registered(AppsScratchGcCommand),
  "apps:scratch:info": registered(AppsScratchInfoCommand),
  "apps:scratch:list": registered(AppsScratchListCommand),
  "apps:scratch:logs": registered(AppsScratchLogsCommand),
  "apps:scratch:run": registered(AppsScratchRunCommand),
  "apps:scratch:start": registered(AppsScratchStartCommand),
  "apps:scratch:stop": registered(AppsScratchStopCommand),
  "meta:bun": registered(BunCommand),
  "meta:config": registered(MetaConfigCommand),
  "meta:doctor": registered(DoctorCommand),
  "meta:events:follow": registered(EventsFollowCommand),
  "meta:global:config": registered(MetaGlobalConfigCommand),
  "meta:global:config:set": registered(MetaGlobalConfigSetCommand),
  "meta:global:config:unset": registered(MetaGlobalConfigUnsetCommand),
  "meta:global:config:edit": registered(MetaGlobalConfigEditCommand),
  "meta:global:config:validate": registered(MetaGlobalConfigValidateCommand),
  "meta:global:destroy": registered(MetaGlobalDestroyCommand),
  "meta:global:info": registered(MetaGlobalInfoCommand),
  "meta:global:install": registered(MetaGlobalInstallCommand),
  "meta:global:list": registered(MetaGlobalListCommand),
  "meta:global:logs": registered(MetaGlobalLogsCommand),
  "meta:global:rebuild": registered(MetaGlobalRebuildCommand),
  "meta:global:restart": registered(MetaGlobalRestartCommand),
  "meta:global:start": registered(MetaGlobalStartCommand),
  "meta:global:status": registered(MetaGlobalStatusCommand),
  "meta:global:stop": registered(MetaGlobalStopCommand),
  "meta:global:uninstall": registered(MetaGlobalUninstallCommand),
  "meta:mcp": registered(MetaMcpCommand),
  "meta:plugin:add": registered(PluginAddCommand),
  "meta:plugin:build": registered(PluginBuildCommand),
  "meta:plugin:link": registered(PluginLinkCommand),
  "meta:plugin:login": registered(PluginLoginCommand),
  "meta:plugin:logout": registered(PluginLogoutCommand),
  "meta:plugin:new": registered(PluginNewCommand),
  "meta:plugin:publish": registered(PluginPublishCommand),
  "meta:plugin:remove": registered(PluginRemoveCommand),
  "meta:plugin:test": registered(PluginTestCommand),
  "meta:plugin:trust": registered(PluginTrustCommand),
  "meta:plugin:trust-authoring-root": registered(PluginTrustAuthoringRootCommand),
  "meta:plugin:unlink": registered(PluginUnlinkCommand),
  "meta:recipes:describe": registered(RecipesDescribeCommand),
  "meta:recipes:list": registered(RecipesListCommand),
  "meta:recipes:validate": registered(RecipesValidateCommand),
  "meta:setup": registered(SetupCommand),
  "meta:shellenv": registered(ShellenvCommand),
  "meta:uninstall": registered(UninstallCommand),
  "meta:update": registered(UpdateCommand),
  "meta:version": registered(VersionCommand),
  "meta:x": registered(XCommand),
} satisfies Readonly<Record<string, BuiltInCommandEntry>>;

const builtInCommandIndex = buildBuiltInCommandIndex(Object.entries(builtInCommandRegistry));

export const builtInCommandEntries: ReadonlyArray<BuiltInCommandEntry> = builtInCommandIndex.entries;

export const deferredBuiltInCommandIds: ReadonlyArray<string> = builtInCommandEntries
  .filter((entry) => entry.status.kind === "deferred")
  .map((entry) => entry.spec.id);

export const isBuiltInCommandImplemented = (commandId: string): boolean =>
  builtInCommandEntries.some((entry) => entry.spec.id === commandId && entry.status.kind === "implemented");

export const resolveBuiltInCommand = (token: string | undefined): BuiltInCommandEntry | undefined =>
  token === undefined ? undefined : builtInCommandIndex.byToken.get(token);

export const isReservedNamespaceHead = (head: string | undefined): boolean =>
  head !== undefined && builtInCommandIndex.namespaceHeads.has(head);

export const notImplementedErrorForCommand = (commandId: string): NotImplementedError => {
  const entry = builtInCommandEntries.find((candidate) => candidate.spec.id === commandId);
  return entry === undefined
    ? new NotImplementedError({
        message: `Command ${commandId} is not implemented.`,
        commandId,
        remediation:
          "This command is not available yet. Run `lando --help` to see currently available commands.",
      })
    : notImplementedErrorForSpec(entry.spec);
};

injectMcpCommandRegistry(mcpRegistryFromBuiltIns(builtInCommandEntries));
