import { Effect } from "effect";

import type { ConfigError, LandoCommandError } from "@lando/sdk/errors";
import type { ConfigService } from "@lando/sdk/services";

import { type AppsListEntry, listServices } from "./list.ts";

export interface PoweroffOptions {
  readonly keepGlobal?: boolean;
  readonly keepScratch?: boolean;
  readonly yes?: boolean;
  readonly userDataRoot?: string;
  readonly stopApp?: (entry: AppsListEntry) => Promise<void>;
}

export interface PoweroffResult {
  readonly appsPoweredOff: ReadonlyArray<string>;
  readonly keptGlobalApp: boolean;
  readonly keptScratchApps: number;
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
  return lines.join("\n");
};

export const poweroff = (
  options: PoweroffOptions = {},
): Effect.Effect<PoweroffResult, ConfigError | LandoCommandError, ConfigService> =>
  Effect.gen(function* () {
    const list = yield* listServices(
      options.userDataRoot === undefined ? {} : { userDataRoot: options.userDataRoot },
    );

    const stopApp =
      options.stopApp ??
      (async (_entry: AppsListEntry) => {
        return;
      });

    const targets: string[] = [];
    let keptScratch = 0;
    for (const app of list.apps) {
      if (options.keepGlobal === true && app.appId === GLOBAL_APP_ID) continue;
      if (options.keepScratch === true && app.appId.startsWith(SCRATCH_PREFIX)) {
        keptScratch += 1;
        continue;
      }
      yield* Effect.promise(() => stopApp(app));
      targets.push(app.appId);
    }

    return {
      appsPoweredOff: targets,
      keptGlobalApp: options.keepGlobal === true,
      keptScratchApps: keptScratch,
    };
  });
