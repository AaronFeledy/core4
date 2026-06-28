import { Effect } from "effect";

import type { ConfigError, LandoCommandError } from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";

import { makeLandoPaths } from "../../config/paths.ts";
import {
  buildManagedRuntimeServiceSpec,
  terminateOwnedRuntimeService,
} from "../../runtime/managed-runtime-service.ts";
import { type AppsListEntry, listServices } from "./list.ts";

export interface RuntimeServiceStopResult {
  readonly terminated: boolean;
  readonly pid?: number;
}

export interface PoweroffOptions {
  readonly keepGlobal?: boolean;
  readonly keepScratch?: boolean;
  readonly yes?: boolean;
  readonly userDataRoot?: string;
  readonly userCacheRoot?: string;
  readonly stopApp?: (entry: AppsListEntry) => Promise<void>;
  readonly stopRuntimeService?: (userDataRoot: string) => Promise<RuntimeServiceStopResult>;
}

export interface PoweroffResult {
  readonly appsPoweredOff: ReadonlyArray<string>;
  readonly keptGlobalApp: boolean;
  readonly keptScratchApps: number;
  readonly runtimeServiceStopped: boolean;
  readonly runtimeServicePid?: number;
}

const GLOBAL_APP_ID = "global";
const SCRATCH_PREFIX = "scratch-";

export const renderPoweroffResult = (result: PoweroffResult): string => {
  const lines: string[] = [];
  if (result.appsPoweredOff.length === 0) {
    lines.push("No Lando apps to power off.");
  } else {
    lines.push(`Powered off: ${result.appsPoweredOff.join(", ")}`);
  }
  if (result.keptGlobalApp) lines.push("kept global app running");
  if (result.keptScratchApps > 0) {
    const plural = result.keptScratchApps === 1 ? "" : "s";
    lines.push(`kept ${result.keptScratchApps} scratch app${plural} running`);
  }
  if (result.runtimeServiceStopped) lines.push("Stopped Lando runtime service");
  return lines.join("\n");
};

const stopManagedRuntimeService = (userDataRoot: string): Promise<RuntimeServiceStopResult> => {
  const paths = makeLandoPaths({ userDataRoot });
  const spec = buildManagedRuntimeServiceSpec(paths);
  return Effect.runPromise(terminateOwnedRuntimeService(spec));
};

export const poweroff = (
  options: PoweroffOptions = {},
): Effect.Effect<PoweroffResult, ConfigError | LandoCommandError, ConfigService> =>
  Effect.gen(function* () {
    const configService = yield* ConfigService;
    const userDataRoot = options.userDataRoot ?? (yield* configService.get("userDataRoot"));
    const list = yield* listServices({
      ...(userDataRoot === undefined ? {} : { userDataRoot }),
      ...(options.userCacheRoot === undefined ? {} : { userCacheRoot: options.userCacheRoot }),
    });

    const stopApp =
      options.stopApp ??
      (async (_entry: AppsListEntry) => {
        return;
      });
    const stopRuntimeService = options.stopRuntimeService ?? stopManagedRuntimeService;

    const targets: string[] = [];
    let keptScratch = 0;
    for (const app of list.apps) {
      if (app.providerId === "cache") continue;
      if (options.keepGlobal === true && app.appId === GLOBAL_APP_ID) continue;
      if (options.keepScratch === true && app.appId.startsWith(SCRATCH_PREFIX)) {
        keptScratch += 1;
        continue;
      }
      yield* Effect.promise(() => stopApp(app));
      targets.push(app.appId);
    }

    const runtimeServiceResult =
      userDataRoot === undefined
        ? { terminated: false }
        : yield* Effect.promise(() => stopRuntimeService(userDataRoot));

    return {
      appsPoweredOff: targets,
      keptGlobalApp: options.keepGlobal === true,
      keptScratchApps: keptScratch,
      runtimeServiceStopped: runtimeServiceResult.terminated,
      ...(runtimeServiceResult.pid === undefined ? {} : { runtimeServicePid: runtimeServiceResult.pid }),
    };
  });
