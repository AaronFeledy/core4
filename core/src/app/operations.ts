import { appConfigLint } from "../cli/commands/app-config-lint.ts";
import { destroyApp } from "../cli/commands/destroy.ts";
import { execApp } from "../cli/commands/exec.ts";
import { infoApp } from "../cli/commands/info.ts";
import { logsApp } from "../cli/commands/logs.ts";
import { rebuildApp } from "../cli/commands/rebuild.ts";
import {
  appPull,
  appPush,
  appRemoteAdd,
  appRemoteEnvList,
  appRemoteList,
  appRemoteRemove,
  appRemoteSetup,
  appRemoteTest,
} from "../cli/commands/remote.ts";
import { restartApp } from "../cli/commands/restart.ts";
import { startApp } from "../cli/commands/start.ts";
import { stopApp } from "../cli/commands/stop.ts";
import { runTooling } from "../cli/commands/tooling.ts";

export const appOperations = {
  startApp,
  stopApp,
  restartApp,
  rebuildApp,
  destroyApp,
  infoApp,
  execApp,
  runTooling,
  logsApp,
  appConfigLint,
  appPull,
  appPush,
  appRemoteList,
  appRemoteAdd,
  appRemoteRemove,
  appRemoteTest,
  appRemoteSetup,
  appRemoteEnvList,
} as const;

export type AppOperations = typeof appOperations;
