import { appConfigLint } from "../operations/app-config-lint.ts";
import { destroyApp } from "../operations/destroy.ts";
import { execApp } from "../operations/exec.ts";
import { infoApp } from "../operations/info.ts";
import { logsApp } from "../operations/logs.ts";
import { rebuildApp } from "../operations/rebuild.ts";
import {
  appPull,
  appPush,
  appRemoteAdd,
  appRemoteEnvList,
  appRemoteList,
  appRemoteRemove,
  appRemoteSetup,
  appRemoteTest,
} from "../operations/remote.ts";
import { restartApp } from "../operations/restart.ts";
import { appShare, appShareList, appShareStop } from "../operations/share.ts";
import { startApp } from "../operations/start.ts";
import { stopApp } from "../operations/stop.ts";
import { runTooling } from "../operations/tooling.ts";

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
  appShare,
  appShareList,
  appShareStop,
} as const;

export type AppOperations = typeof appOperations;
