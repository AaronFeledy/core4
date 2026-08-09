import { NotImplementedError } from "@lando/sdk/errors";

import type { BootstrapLevel } from "@lando/engine/runtime/bootstrap";
import { buildBuiltInCommandIndex } from "./built-in-command-index";
import AppCacheRefreshCommand from "./command-specs/app/cache/refresh";
import AppConfigCommand from "./command-specs/app/config";
import AppConfigLintCommand from "./command-specs/app/config/lint";
import AppConfigTranslateCommand from "./command-specs/app/config/translate";
import {
  AppConfigEditCommand,
  AppConfigSetCommand,
  AppConfigUnsetCommand,
  AppConfigValidateCommand,
} from "./command-specs/app/config/verbs";
import DestroyCommand from "./command-specs/app/destroy";
import ExecCommand from "./command-specs/app/exec";
import AppIncludesUpdateCommand from "./command-specs/app/includes/update";
import AppIncludesVerifyCommand from "./command-specs/app/includes/verify";
import InfoCommand from "./command-specs/app/info";
import LogsCommand from "./command-specs/app/logs";
import OpenCommand from "./command-specs/app/open";
import PullCommand from "./command-specs/app/pull";
import PushCommand from "./command-specs/app/push";
import RebuildCommand from "./command-specs/app/rebuild";
import RemoteAddCommand from "./command-specs/app/remote/add";
import RemoteEnvListCommand from "./command-specs/app/remote/env/list";
import RemoteListCommand from "./command-specs/app/remote/list";
import RemoteRemoveCommand from "./command-specs/app/remote/remove";
import RemoteSetupCommand from "./command-specs/app/remote/setup";
import RemoteTestCommand from "./command-specs/app/remote/test";
import RestartCommand from "./command-specs/app/restart";
import ShareCommand from "./command-specs/app/share";
import ShareListCommand from "./command-specs/app/share/list";
import ShareStopCommand from "./command-specs/app/share/stop";
import ShellCommand from "./command-specs/app/shell";
import SshCommand from "./command-specs/app/ssh";
import StartCommand from "./command-specs/app/start";
import StopCommand from "./command-specs/app/stop";
import InitCommand from "./command-specs/apps/init";
import ListCommand from "./command-specs/apps/list";
import PoweroffCommand from "./command-specs/apps/poweroff";
import AppsScratchDestroyCommand from "./command-specs/apps/scratch/destroy";
import AppsScratchGcCommand from "./command-specs/apps/scratch/gc";
import AppsScratchInfoCommand from "./command-specs/apps/scratch/info";
import AppsScratchListCommand from "./command-specs/apps/scratch/list";
import AppsScratchLogsCommand from "./command-specs/apps/scratch/logs";
import AppsScratchRunCommand from "./command-specs/apps/scratch/run";
import AppsScratchStartCommand from "./command-specs/apps/scratch/start";
import AppsScratchStopCommand from "./command-specs/apps/scratch/stop";
import BunCommand from "./command-specs/meta/bun";
import MetaConfigCommand from "./command-specs/meta/config";
import DoctorCommand from "./command-specs/meta/doctor";
import EventsFollowCommand from "./command-specs/meta/events/follow";
import MetaGlobalConfigCommand from "./command-specs/meta/global/config";
import {
  MetaGlobalConfigEditCommand,
  MetaGlobalConfigSetCommand,
  MetaGlobalConfigUnsetCommand,
  MetaGlobalConfigValidateCommand,
} from "./command-specs/meta/global/config-verbs";
import MetaGlobalDestroyCommand from "./command-specs/meta/global/destroy";
import MetaGlobalInfoCommand from "./command-specs/meta/global/info";
import MetaGlobalInstallCommand from "./command-specs/meta/global/install";
import MetaGlobalListCommand from "./command-specs/meta/global/list";
import MetaGlobalLogsCommand from "./command-specs/meta/global/logs";
import MetaGlobalRebuildCommand from "./command-specs/meta/global/rebuild";
import MetaGlobalRestartCommand from "./command-specs/meta/global/restart";
import MetaGlobalStartCommand from "./command-specs/meta/global/start";
import MetaGlobalStatusCommand from "./command-specs/meta/global/status";
import MetaGlobalStopCommand from "./command-specs/meta/global/stop";
import MetaGlobalUninstallCommand from "./command-specs/meta/global/uninstall";
import MetaMcpCommand, { injectMcpCommandRegistry } from "./command-specs/meta/mcp";
import PluginAddCommand from "./command-specs/meta/plugin/add";
import PluginBuildCommand from "./command-specs/meta/plugin/build";
import PluginLinkCommand from "./command-specs/meta/plugin/link";
import PluginLoginCommand from "./command-specs/meta/plugin/login";
import PluginLogoutCommand from "./command-specs/meta/plugin/logout";
import PluginNewCommand from "./command-specs/meta/plugin/new";
import PluginPublishCommand from "./command-specs/meta/plugin/publish";
import PluginRemoveCommand from "./command-specs/meta/plugin/remove";
import PluginTestCommand from "./command-specs/meta/plugin/test";
import PluginTrustCommand from "./command-specs/meta/plugin/trust";
import PluginTrustAuthoringRootCommand from "./command-specs/meta/plugin/trust-authoring-root";
import PluginUnlinkCommand from "./command-specs/meta/plugin/unlink";
import RecipesDescribeCommand from "./command-specs/meta/recipes/describe";
import RecipesListCommand from "./command-specs/meta/recipes/list";
import RecipesValidateCommand from "./command-specs/meta/recipes/validate";
import SetupCommand from "./command-specs/meta/setup";
import ShellenvCommand from "./command-specs/meta/shellenv";
import UninstallCommand from "./command-specs/meta/uninstall";
import UpdateCommand from "./command-specs/meta/update";
import VersionCommand from "./command-specs/meta/version";
import XCommand from "./command-specs/meta/x";
import { mcpRegistryFromBuiltIns } from "./commands/meta/mcp";
import { type DeferredCommandPlan, notImplementedErrorForSpec } from "./deferred-commands";
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
