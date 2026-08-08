import { type Context, Effect, Option, Schema } from "effect";

import type { ConfigError, LandoCommandError } from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";

import { HostMaintenanceRegistry, teardownHostMaintainers } from "@lando/engine/runtime/host-maintenance";
import { makeLandoPaths, normalizeHostPlatform } from "@lando/paths";
import { type AppsListEntry, listServices } from "./list";

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

export const PoweroffResultSchema = Schema.Struct({
  appsPoweredOff: Schema.Array(Schema.String),
  keptGlobalApp: Schema.Boolean,
  keptScratchApps: Schema.Number,
  runtimeServiceStopped: Schema.Boolean,
  runtimeServicePid: Schema.optional(Schema.Number),
});

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

const stopManagedRuntimeService = (
  registry: Option.Option<Context.Tag.Service<typeof HostMaintenanceRegistry>>,
  userDataRoot: string,
): Promise<RuntimeServiceStopResult> => {
  const platform = normalizeHostPlatform();
  const paths = makeLandoPaths({ userDataRoot, platform });
  return Option.match(registry, {
    onNone: () => Promise.resolve({ terminated: false }),
    onSome: (service) => Effect.runPromise(teardownHostMaintainers(service, { paths, platform })),
  });
};

export const poweroff = (
  options: PoweroffOptions = {},
): Effect.Effect<PoweroffResult, ConfigError | LandoCommandError, ConfigService> =>
  Effect.gen(function* () {
    const hostMaintenanceRegistry = yield* Effect.serviceOption(HostMaintenanceRegistry);
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
    const stopRuntimeService =
      options.stopRuntimeService ??
      ((root: string) => stopManagedRuntimeService(hostMaintenanceRegistry, root));

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
