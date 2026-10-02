import { type Context, DateTime, Effect, Option, Schema } from "effect";

import type { CacheError, ConfigError, LandoCommandError } from "@lando/sdk/errors";
import { PostGlobalStopEvent, PreGlobalStopEvent } from "@lando/sdk/events";
import { AbsolutePath, AppId, ProviderId } from "@lando/sdk/schema";
import { ConfigService, EventService, RuntimeProviderRegistry, ScratchAppService } from "@lando/sdk/services";

import { MANAGED_PROVIDER_SELECT_PLAN, taggedErrorRemediation } from "@lando/engine/providers/managed";
import { HostMaintenanceRegistry, teardownHostMaintainers } from "@lando/engine/runtime/host-maintenance";
import { ScratchResourceScanner, isCanonicalScratchId } from "@lando/engine/scratch-app/scanner";
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
  readonly discoverContainers?: (userDataRoot: string) => Promise<ReadonlyArray<AppsListEntry>>;
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

export class PoweroffStopError extends Schema.TaggedError<PoweroffStopError>()("PoweroffStopError", {
  message: Schema.String,
  appId: Schema.String,
  providerId: Schema.String,
  cause: Schema.Unknown,
  remediation: Schema.String,
}) {}

export type PoweroffServices =
  | ConfigService
  | EventService
  | RuntimeProviderRegistry
  | ScratchAppService
  | ScratchResourceScanner;
export type PoweroffError = CacheError | ConfigError | LandoCommandError | PoweroffStopError;

const isScratch = (entry: AppsListEntry): boolean => entry.scratch === true;

const stopDiscoveredApp = (entry: AppsListEntry) =>
  Effect.gen(function* () {
    if (isScratch(entry)) {
      const scratches = yield* ScratchAppService;
      yield* scratches.destroy(entry.appId, { keepVolumes: false }).pipe(
        Effect.asVoid,
        Effect.catchTag("ScratchAppNotFoundError", (error) =>
          Effect.gen(function* () {
            if (!isCanonicalScratchId(entry.appId)) return yield* Effect.fail(error);
            const scanner = yield* ScratchResourceScanner;
            yield* scanner.pruneScratch(entry.appId);
          }),
        ),
      );
      return;
    }
    const registry = yield* RuntimeProviderRegistry;
    const selection =
      entry.appId === GLOBAL_APP_ID
        ? MANAGED_PROVIDER_SELECT_PLAN
        : { ...MANAGED_PROVIDER_SELECT_PLAN, provider: ProviderId.make(entry.providerId) };
    const provider = yield* registry.select(selection);
    const globalApp =
      entry.appId === GLOBAL_APP_ID
        ? { kind: "global" as const, id: AppId.make(entry.appId), root: AbsolutePath.make(entry.appRoot) }
        : undefined;
    if (globalApp !== undefined) {
      const events = yield* EventService;
      yield* events.publish(
        PreGlobalStopEvent.make({
          scope: "global",
          app: globalApp,
          triggeredBy: "apps:poweroff",
          timestamp: yield* DateTime.now,
        }),
      );
    }
    const outcome = yield* provider.destroy(
      { app: AppId.make(entry.appId) },
      { volumes: false, removeState: false },
    );
    switch (outcome.kind) {
      case "destroyed":
        if (globalApp !== undefined) {
          const events = yield* EventService;
          yield* events.publish(
            PostGlobalStopEvent.make({
              scope: "global",
              app: globalApp,
              timestamp: yield* DateTime.now,
            }),
          );
        }
        return;
      case "no-op":
        return yield* Effect.fail(
          new PoweroffStopError({
            message: `Cannot stop ${entry.appId}: its provider has no applied plan.`,
            appId: entry.appId,
            providerId: String(provider.id),
            cause: outcome,
            remediation:
              "Restore the app's applied state or stop its orphaned resources with `lando stop` from its app root, then retry poweroff.",
          }),
        );
      default:
        return outcome satisfies never;
    }
  });

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

export function poweroff(
  options: PoweroffOptions & { readonly stopApp: NonNullable<PoweroffOptions["stopApp"]> },
): Effect.Effect<PoweroffResult, PoweroffError, ConfigService>;
export function poweroff(
  options?: PoweroffOptions,
): Effect.Effect<PoweroffResult, PoweroffError, PoweroffServices>;
export function poweroff(
  options: PoweroffOptions = {},
): Effect.Effect<PoweroffResult, PoweroffError, PoweroffServices> {
  return Effect.gen(function* () {
    const hostMaintenanceRegistry = yield* Effect.serviceOption(HostMaintenanceRegistry);
    const configService = yield* ConfigService;
    const userDataRoot = options.userDataRoot ?? (yield* configService.get("userDataRoot"));
    const list = yield* listServices({
      includeScratch: true,
      ...(userDataRoot === undefined ? {} : { userDataRoot }),
      ...(options.userCacheRoot === undefined ? {} : { userCacheRoot: options.userCacheRoot }),
      ...(options.discoverContainers === undefined ? {} : { discoverContainers: options.discoverContainers }),
    });

    const stopRuntimeService =
      options.stopRuntimeService ??
      ((root: string) => stopManagedRuntimeService(hostMaintenanceRegistry, root));

    const targets: string[] = [];
    let keptScratch = 0;
    const stopOrder = (app: AppsListEntry): number =>
      app.appId === GLOBAL_APP_ID ? 2 : isScratch(app) ? 1 : 0;
    for (const app of [...list.apps].sort((left, right) => stopOrder(left) - stopOrder(right))) {
      if (app.providerId === "cache") continue;
      if (options.keepGlobal === true && app.appId === GLOBAL_APP_ID) continue;
      if (options.keepScratch === true && isScratch(app)) {
        keptScratch += 1;
        continue;
      }
      const injectedStop = options.stopApp;
      const stop: Effect.Effect<void, unknown, Exclude<PoweroffServices, ConfigService>> = injectedStop ===
      undefined
        ? stopDiscoveredApp(app)
        : Effect.tryPromise({ try: () => injectedStop(app), catch: (cause) => cause });
      yield* stop.pipe(
        Effect.mapError((cause) =>
          cause instanceof PoweroffStopError
            ? cause
            : new PoweroffStopError({
                message: `Failed to power off ${app.appId}.`,
                appId: app.appId,
                providerId:
                  app.appId === GLOBAL_APP_ID
                    ? String(MANAGED_PROVIDER_SELECT_PLAN.provider)
                    : app.providerId,
                cause,
                remediation: isScratch(app)
                  ? `${taggedErrorRemediation(cause) ?? "Resolve the scratch cleanup failure."} Run \`lando scratch gc --prune\`, then retry poweroff; the managed runtime has been left available.`
                  : (taggedErrorRemediation(cause) ??
                    "Resolve the app stop failure and retry poweroff; the managed runtime has been left available."),
              }),
        ),
      );
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
}
