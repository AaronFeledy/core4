import { Effect } from "effect";

import type { ShareAppError, ShareStopAppResult } from "@lando/sdk/app";
import type { StateStore } from "@lando/sdk/services";

import { appConfigLint } from "../operations/app-config-lint.ts";
import { destroyAppForTarget } from "../operations/destroy.ts";
import { execApp } from "../operations/exec.ts";
import { infoApp } from "../operations/info.ts";
import { logsAppForTarget } from "../operations/logs.ts";
import { rebuildApp } from "../operations/rebuild.ts";
import {
  appPullForTarget,
  appPushForTarget,
  appRemoteAdd,
  appRemoteEnvList,
  appRemoteList,
  appRemoteRemove,
  appRemoteSetup,
  appRemoteTest,
} from "../operations/remote.ts";
import { restartApp } from "../operations/restart.ts";
import { appShareForTarget, appShareListForTarget, appShareStop } from "../operations/share.ts";
import { startAppForTarget } from "../operations/start.ts";
import { stopAppForTarget } from "../operations/stop.ts";
import { runTooling } from "../operations/tooling.ts";

const appShareStopForHandle = (
  options: Parameters<typeof appShareStop>[0],
): Effect.Effect<ShareStopAppResult, ShareAppError, StateStore> =>
  appShareStop(options).pipe(
    Effect.map((result) => ({
      sessionId: result.sessionId,
      ...(result.provider === undefined ? {} : { provider: result.provider }),
      status: "stopped",
    })),
  );

export const appOperations = {
  startApp: startAppForTarget,
  stopApp: stopAppForTarget,
  restartApp,
  rebuildApp,
  destroyApp: destroyAppForTarget,
  infoApp,
  execApp,
  runTooling,
  logsApp: logsAppForTarget,
  appConfigLint,
  appPull: appPullForTarget,
  appPush: appPushForTarget,
  appRemoteList,
  appRemoteAdd,
  appRemoteRemove,
  appRemoteTest,
  appRemoteSetup,
  appRemoteEnvList,
  appShare: appShareForTarget,
  appShareList: appShareListForTarget,
  appShareStop: appShareStopForHandle,
} as const;

export type AppOperations = typeof appOperations;
