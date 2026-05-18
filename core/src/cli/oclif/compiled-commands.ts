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
import BunCommand from "./commands/meta/bun.ts";
import MetaConfigCommand from "./commands/meta/config.ts";
import DoctorCommand from "./commands/meta/doctor.ts";
import EventsFollowCommand from "./commands/meta/events/follow.ts";
import PluginAddCommand from "./commands/meta/plugin/add.ts";
import PluginBuildCommand from "./commands/meta/plugin/build.ts";
import PluginLinkCommand from "./commands/meta/plugin/link.ts";
import PluginLoginCommand from "./commands/meta/plugin/login.ts";
import PluginLogoutCommand from "./commands/meta/plugin/logout.ts";
import PluginNewCommand from "./commands/meta/plugin/new.ts";
import PluginPublishCommand from "./commands/meta/plugin/publish.ts";
import PluginRemoveCommand from "./commands/meta/plugin/remove.ts";
import PluginTestCommand from "./commands/meta/plugin/test.ts";
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
  "meta:bun": BunCommand,
  "meta:config": MetaConfigCommand,
  "meta:doctor": DoctorCommand,
  "meta:events:follow": EventsFollowCommand,
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
  "meta:plugin:unlink": PluginUnlinkCommand,
  "meta:recipes:list": RecipesListCommand,
  "meta:setup": SetupCommand,
  "meta:shellenv": ShellenvCommand,
  "meta:uninstall": UninstallCommand,
  "meta:update": UpdateCommand,
  "meta:version": VersionCommand,
  "meta:x": XCommand,
} satisfies Record<string, Command.Class>;
