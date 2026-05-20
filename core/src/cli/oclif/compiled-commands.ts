import type { Command } from "@oclif/core";

import AppCacheRefreshCommand from "./commands/app/cache/refresh.ts";
import AppConfigCommand from "./commands/app/config/index.ts";
import AppConfigTranslateCommand from "./commands/app/config/translate.ts";
import DestroyCommand from "./commands/app/destroy.ts";
import ExecCommand from "./commands/app/exec.ts";
import AppIncludesUpdateCommand from "./commands/app/includes/update.ts";
import AppIncludesVerifyCommand from "./commands/app/includes/verify.ts";
import InfoCommand from "./commands/app/info.ts";
import LogsCommand from "./commands/app/logs.ts";
import RebuildCommand from "./commands/app/rebuild.ts";
import RestartCommand from "./commands/app/restart.ts";
import ShellCommand from "./commands/app/shell.ts";
import SshCommand from "./commands/app/ssh.ts";
import StartCommand from "./commands/app/start.ts";
import StopCommand from "./commands/app/stop.ts";
import InitCommand from "./commands/apps/init.ts";
import ListCommand from "./commands/apps/list.ts";
import PoweroffCommand from "./commands/apps/poweroff.ts";
import AppsScratchDestroyCommand from "./commands/apps/scratch/destroy.ts";
import AppsScratchGcCommand from "./commands/apps/scratch/gc.ts";
import AppsScratchInfoCommand from "./commands/apps/scratch/info.ts";
import AppsScratchListCommand from "./commands/apps/scratch/list.ts";
import AppsScratchLogsCommand from "./commands/apps/scratch/logs.ts";
import AppsScratchStartCommand from "./commands/apps/scratch/start.ts";
import AppsScratchStopCommand from "./commands/apps/scratch/stop.ts";
import BunCommand from "./commands/meta/bun.ts";
import MetaConfigCommand from "./commands/meta/config.ts";
import DoctorCommand from "./commands/meta/doctor.ts";
import EventsFollowCommand from "./commands/meta/events/follow.ts";
import MetaGlobalConfigCommand from "./commands/meta/global/config.ts";
import MetaGlobalDestroyCommand from "./commands/meta/global/destroy.ts";
import MetaGlobalInfoCommand from "./commands/meta/global/info.ts";
import MetaGlobalInstallCommand from "./commands/meta/global/install.ts";
import MetaGlobalListCommand from "./commands/meta/global/list.ts";
import MetaGlobalLogsCommand from "./commands/meta/global/logs.ts";
import MetaGlobalRebuildCommand from "./commands/meta/global/rebuild.ts";
import MetaGlobalRestartCommand from "./commands/meta/global/restart.ts";
import MetaGlobalStartCommand from "./commands/meta/global/start.ts";
import MetaGlobalStopCommand from "./commands/meta/global/stop.ts";
import MetaGlobalUninstallCommand from "./commands/meta/global/uninstall.ts";
import PluginAddCommand from "./commands/meta/plugin/add.ts";
import PluginBuildCommand from "./commands/meta/plugin/build.ts";
import PluginLinkCommand from "./commands/meta/plugin/link.ts";
import PluginLoginCommand from "./commands/meta/plugin/login.ts";
import PluginLogoutCommand from "./commands/meta/plugin/logout.ts";
import PluginNewCommand from "./commands/meta/plugin/new.ts";
import PluginPublishCommand from "./commands/meta/plugin/publish.ts";
import PluginRemoveCommand from "./commands/meta/plugin/remove.ts";
import PluginTestCommand from "./commands/meta/plugin/test.ts";
import PluginTrustAuthoringRootCommand from "./commands/meta/plugin/trust-authoring-root.ts";
import PluginTrustCommand from "./commands/meta/plugin/trust.ts";
import PluginUnlinkCommand from "./commands/meta/plugin/unlink.ts";
import RecipesListCommand from "./commands/meta/recipes/list.ts";
import SetupCommand from "./commands/meta/setup.ts";
import ShellenvCommand from "./commands/meta/shellenv.ts";
import UninstallCommand from "./commands/meta/uninstall.ts";
import UpdateCommand from "./commands/meta/update.ts";
import VersionCommand from "./commands/meta/version.ts";
import XCommand from "./commands/meta/x.ts";

export default {
  "app:cache:refresh": AppCacheRefreshCommand,
  "app:config": AppConfigCommand,
  "app:config:translate": AppConfigTranslateCommand,
  "app:destroy": DestroyCommand,
  "app:exec": ExecCommand,
  "app:includes:update": AppIncludesUpdateCommand,
  "app:includes:verify": AppIncludesVerifyCommand,
  "app:info": InfoCommand,
  "app:logs": LogsCommand,
  "app:rebuild": RebuildCommand,
  "app:restart": RestartCommand,
  "app:shell": ShellCommand,
  "app:ssh": SshCommand,
  "app:start": StartCommand,
  "app:stop": StopCommand,
  "apps:init": InitCommand,
  "apps:list": ListCommand,
  "apps:poweroff": PoweroffCommand,
  "apps:scratch:destroy": AppsScratchDestroyCommand,
  "apps:scratch:gc": AppsScratchGcCommand,
  "apps:scratch:info": AppsScratchInfoCommand,
  "apps:scratch:list": AppsScratchListCommand,
  "apps:scratch:logs": AppsScratchLogsCommand,
  "apps:scratch:start": AppsScratchStartCommand,
  "apps:scratch:stop": AppsScratchStopCommand,
  "meta:bun": BunCommand,
  "meta:config": MetaConfigCommand,
  "meta:doctor": DoctorCommand,
  "meta:events:follow": EventsFollowCommand,
  "meta:global:config": MetaGlobalConfigCommand,
  "meta:global:destroy": MetaGlobalDestroyCommand,
  "meta:global:info": MetaGlobalInfoCommand,
  "meta:global:install": MetaGlobalInstallCommand,
  "meta:global:list": MetaGlobalListCommand,
  "meta:global:logs": MetaGlobalLogsCommand,
  "meta:global:rebuild": MetaGlobalRebuildCommand,
  "meta:global:restart": MetaGlobalRestartCommand,
  "meta:global:start": MetaGlobalStartCommand,
  "meta:global:stop": MetaGlobalStopCommand,
  "meta:global:uninstall": MetaGlobalUninstallCommand,
  "meta:plugin:add": PluginAddCommand,
  "meta:plugin:build": PluginBuildCommand,
  "meta:plugin:link": PluginLinkCommand,
  "meta:plugin:login": PluginLoginCommand,
  "meta:plugin:logout": PluginLogoutCommand,
  "meta:plugin:new": PluginNewCommand,
  "meta:plugin:publish": PluginPublishCommand,
  "meta:plugin:remove": PluginRemoveCommand,
  "meta:plugin:test": PluginTestCommand,
  "meta:plugin:trust": PluginTrustCommand,
  "meta:plugin:trust-authoring-root": PluginTrustAuthoringRootCommand,
  "meta:plugin:unlink": PluginUnlinkCommand,
  "meta:recipes:list": RecipesListCommand,
  "meta:setup": SetupCommand,
  "meta:shellenv": ShellenvCommand,
  "meta:uninstall": UninstallCommand,
  "meta:update": UpdateCommand,
  "meta:version": VersionCommand,
  "meta:x": XCommand,
} satisfies Record<string, Command.Class>;
