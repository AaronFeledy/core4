import { makeLandoPaths, normalizeHostPlatform } from "@lando/paths";
import {
  ConfigService,
  type FileSystem,
  ProcessRunner,
  type RuntimeProviderRegistry,
  ScratchAppService,
  type StateStore,
} from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Option, Result, Schema } from "effect";
import { HostMaintenanceRegistry, teardownHostMaintainers } from "../runtime/host-maintenance.ts";
import { CORE_VERSION } from "../version.ts";
import { type GlobalStopError, type GlobalStopServices, globalStop } from "./global-stop.ts";
import {
  PoweroffAppResultSchema,
  PoweroffStopFailureSchema,
  type StopFailure,
  appResult,
  stopEntries,
} from "./poweroff-failures.ts";
import { readRunningInventory } from "./running-inventory.ts";
import { type StopAppError, stopAppAtRoot } from "./stop.ts";

export type PoweroffAppResult = typeof PoweroffAppResultSchema.Type;

const poweroffKeepFields = {
  keptGlobalApp: Schema.Boolean,
  keptScratchApps: Schema.Number,
};

export const PoweroffResultSchema = Schema.Struct({
  apps: Schema.Array(PoweroffAppResultSchema),
  ...poweroffKeepFields,
  runtimeServiceStopped: Schema.Boolean,
  runtimeServicePid: Schema.optionalKey(Schema.Number),
});

export type PoweroffResult = typeof PoweroffResultSchema.Type;

export class PoweroffStopError extends Schema.TaggedError<PoweroffStopError>()("PoweroffStopError", {
  message: Schema.NonEmptyString,
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  apps: Schema.Array(PoweroffAppResultSchema),
  failures: Schema.Array(PoweroffStopFailureSchema),
  ...poweroffKeepFields,
}) {}

export interface PoweroffOptions {
  readonly keepGlobal?: boolean;
  readonly keepScratch?: boolean;
}

export type PoweroffServices =
  | ConfigService
  | FileSystem
  | GlobalStopServices
  | PrivateFileAccessService
  | ProcessRunner
  | RuntimeProviderRegistry
  | ScratchAppService
  | StateStore
  | Effect.Services<ReturnType<typeof stopAppAtRoot>>;

export type PoweroffError = GlobalStopError | PoweroffStopError | StopAppError;

type RuntimeServiceStopResult = { readonly terminated: boolean; readonly pid?: number };
export const poweroff = Effect.fn("AppsPoweroff.poweroff")(function* (
  options: PoweroffOptions = {},
): Effect.fn.Return<PoweroffResult, PoweroffError, PoweroffServices> {
  const inventory = yield* readRunningInventory();
  const failures: StopFailure[] = [...inventory.failures];
  const apps: PoweroffAppResult[] = [];

  const userOrder = [...inventory.userTargets.values()].sort((left, right) =>
    `${left.appRoot}\0${left.appId}`.localeCompare(`${right.appRoot}\0${right.appId}`),
  );
  for (const target of userOrder) {
    const stopped = yield* stopAppAtRoot(target.appRoot, { providerId: target.providerId }, "poweroff").pipe(
      Effect.result,
    );
    if (Result.isFailure(stopped)) {
      failures.push({
        kind: "user",
        appId: String(target.appId),
        appRoot: target.appRoot,
        providerId: String(target.providerId),
        error: stopped.failure,
      });
      continue;
    }
    apps.push(
      appResult(
        {
          kind: "user",
          appId: stopped.success.app,
          appRoot: target.appRoot,
          providerId: String(target.providerId),
        },
        stopped.success.outcome ?? "unchanged",
        stopped.success,
      ),
    );
  }

  const { scratchTargets, failures: scratchFailures } = yield* inventory.readScratch;
  failures.push(...scratchFailures);

  const scratches = yield* ScratchAppService;
  let keptScratch = 0;
  for (const target of [...scratchTargets.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    if (options.keepScratch === true) {
      keptScratch += 1;
      continue;
    }
    const destroyed = yield* scratches
      .destroy(target.id, { keepVolumes: false, reason: "poweroff" })
      .pipe(Effect.result);
    if (Result.isFailure(destroyed)) {
      failures.push({
        kind: "scratch",
        appId: target.id,
        appRoot: target.appRoot,
        providerId: String(target.providerId),
        error: destroyed.failure,
      });
      continue;
    }
    apps.push(
      appResult(
        {
          kind: "scratch",
          appId: target.id,
          appRoot: destroyed.success.app.root,
          providerId: String(target.providerId),
        },
        "destroyed",
      ),
    );
  }

  const keepGlobal = options.keepGlobal === true;
  const globalTargetResult = keepGlobal
    ? undefined
    : yield* inventory.resolveGlobalTarget.pipe(Effect.result);
  const globalTarget =
    globalTargetResult !== undefined && Result.isSuccess(globalTargetResult)
      ? globalTargetResult.success
      : undefined;
  if (globalTargetResult !== undefined && Result.isFailure(globalTargetResult))
    failures.push({
      kind: "global",
      appId: "global",
      appRoot: "",
      providerId: "global",
      error: globalTargetResult.failure,
    });
  let globalStopped = false;
  if (globalTarget === undefined || failures.length > 0) {
    apps.push(
      appResult(
        {
          kind: "global",
          appId: "global",
          appRoot: globalTarget?.root ?? "",
          providerId: String(globalTarget?.providerId ?? "global"),
        },
        "skipped",
      ),
    );
  } else {
    const stopped = yield* globalStop({ target: globalTarget, triggeredBy: "apps:poweroff" }).pipe(
      Effect.result,
    );
    if (Result.isFailure(stopped)) {
      failures.push({
        kind: "global",
        appId: "global",
        appRoot: globalTarget.root,
        providerId: String(globalTarget.providerId),
        error: stopped.failure,
      });
    } else {
      globalStopped = true;
      apps.push(
        appResult(
          {
            kind: "global",
            appId: "global",
            appRoot: globalTarget.root,
            providerId: String(globalTarget.providerId),
          },
          stopped.success.outcome,
          stopped.success,
        ),
      );
    }
  }

  const kept = { keptGlobalApp: keepGlobal, keptScratchApps: keptScratch };
  if (failures.length > 0) {
    return yield* Effect.fail(
      new PoweroffStopError({
        message: `Failed to power off ${failures.length === 1 ? "one app" : `${failures.length} apps`}.`,
        remediation:
          "Resolve each reported failure and retry `lando poweroff`; the managed runtime was left running.",
        apps,
        failures: yield* stopEntries(failures),
        ...kept,
      }),
    );
  }

  const runtimeService =
    !keepGlobal && globalStopped && keptScratch === 0
      ? yield* stopManagedRuntimeService
      : ({ terminated: false } satisfies RuntimeServiceStopResult);
  return {
    apps,
    ...kept,
    runtimeServiceStopped: runtimeService.terminated,
    ...(runtimeService.pid === undefined ? {} : { runtimeServicePid: runtimeService.pid }),
  };
});

const stopManagedRuntimeService: Effect.Effect<
  RuntimeServiceStopResult,
  never,
  ConfigService | PrivateFileAccessService | ProcessRunner
> = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(HostMaintenanceRegistry);
  if (Option.isNone(service)) return { terminated: false };
  const config = yield* ConfigService;
  const userDataRoot = yield* config.get("userDataRoot");
  if (userDataRoot === undefined) return { terminated: false };
  const privateFileAccess = yield* PrivateFileAccessService;
  const processRunner = yield* ProcessRunner;
  const platform = normalizeHostPlatform();
  const paths = makeLandoPaths({ userDataRoot, platform });
  const stateStore = makeStateStore({ privateFileAccess, roots: paths.roots, writer: CORE_VERSION });
  const result = yield* teardownHostMaintainers(service.value, {
    paths,
    platform,
    privateFileAccess,
    processRunner,
    stateStore,
  });
  return result satisfies RuntimeServiceStopResult;
});
