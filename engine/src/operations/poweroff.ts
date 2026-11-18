import { makeLandoPaths, normalizeHostPlatform } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import { StopAppResult } from "@lando/sdk/schema";
import {
  ConfigService,
  type FileSystem,
  GlobalAppService,
  type RuntimeProviderRegistry,
  ScratchAppService,
  type StateStore,
} from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Option, Result, Schema } from "effect";
import { globalObserveProviderId } from "../global-app/placement.ts";
import { taggedErrorRemediation } from "../providers/managed.ts";
import { HostMaintenanceRegistry, teardownHostMaintainers } from "../runtime/host-maintenance.ts";
import { type GlobalStopError, type GlobalStopServices, globalStop } from "./global-stop.ts";
import { readRunningInventory } from "./running-inventory.ts";
import { type StopAppError, stopAppAtRoot } from "./stop.ts";

const PoweroffAppKind = Schema.Literals(["user", "scratch", "global"]);
const PoweroffAppOutcome = Schema.Literals(["stopped", "unchanged", "destroyed", "skipped"]);

const PoweroffAppResultSchema = Schema.Struct({
  kind: PoweroffAppKind,
  appId: Schema.String,
  appRoot: Schema.String,
  providerId: Schema.String,
  outcome: PoweroffAppOutcome,
  servicesStopped: Schema.optionalKey(StopAppResult.fields.servicesStopped),
  landofileEvents: StopAppResult.fields.landofileEvents,
  shutdownObservations: StopAppResult.fields.shutdownObservations,
});

export type PoweroffAppResult = typeof PoweroffAppResultSchema.Type;

const PoweroffStopFailureSchema = Schema.Struct({
  kind: PoweroffAppKind,
  appId: Schema.String,
  appRoot: Schema.String,
  providerId: Schema.String,
  _tag: Schema.String,
  message: Schema.String,
  remediation: Schema.NonEmptyString,
});

type PoweroffStopFailure = typeof PoweroffStopFailureSchema.Type;

export const PoweroffResultSchema = Schema.Struct({
  apps: Schema.Array(PoweroffAppResultSchema),
  keptGlobalApp: Schema.Boolean,
  keptScratchApps: Schema.Number,
  runtimeServiceStopped: Schema.Boolean,
  runtimeServicePid: Schema.optionalKey(Schema.Number),
});

export type PoweroffResult = typeof PoweroffResultSchema.Type;

export class PoweroffStopError extends Schema.TaggedError<PoweroffStopError>()("PoweroffStopError", {
  message: Schema.NonEmptyString,
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  apps: Schema.Array(PoweroffAppResultSchema),
  failures: Schema.Array(PoweroffStopFailureSchema),
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
  | RuntimeProviderRegistry
  | ScratchAppService
  | StateStore
  | Effect.Services<ReturnType<typeof stopAppAtRoot>>;

export type PoweroffError = GlobalStopError | PoweroffStopError | StopAppError;

type RuntimeServiceStopResult = { readonly terminated: boolean; readonly pid?: number };
type StopFailure = {
  readonly kind: PoweroffAppResult["kind"];
  readonly appId: string;
  readonly appRoot: string;
  readonly providerId: string;
  readonly error: unknown;
};

const failureTag = (error: unknown): string => {
  if (error !== null && typeof error === "object") {
    const tag = Reflect.get(error, "_tag");
    if (typeof tag === "string" && tag.length > 0) return tag;
  }
  return error instanceof Error && error.name.length > 0 ? error.name : "UnknownError";
};

const failureMessage = (error: unknown): string => {
  if (error !== null && typeof error === "object") {
    const message = Reflect.get(error, "message");
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(error);
};

const failureRemediation = (error: unknown): string =>
  taggedErrorRemediation(error) ?? "Resolve the reported failure for this app, then retry `lando poweroff`.";

const redacted = Effect.fnUntraced(function* (text: string) {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (Option.isNone(redaction)) return text;
  const profile = yield* redaction.value.forProfile("secrets", { sourceEnv: process.env });
  return profile.redactString(text);
});

const stopFailure = Effect.fnUntraced(function* (
  target: Pick<StopFailure, "kind" | "appId" | "appRoot" | "providerId">,
  error: unknown,
) {
  // App-scoped failures name the app; provider and inventory failures carry no root to name.
  const message =
    target.appRoot === ""
      ? failureMessage(error)
      : `${target.appId} (${target.appRoot}): ${failureMessage(error)}`;
  return {
    ...target,
    _tag: failureTag(error),
    message: yield* redacted(message),
    remediation: yield* redacted(failureRemediation(error)),
  } satisfies PoweroffStopFailure;
});

const stopEntries = (failures: ReadonlyArray<StopFailure>): Effect.Effect<PoweroffStopFailure[]> =>
  Effect.forEach(failures, (failure) => stopFailure(failure, failure.error), { concurrency: 1 });

const appResult = (
  target: Pick<StopFailure, "kind" | "appId" | "appRoot" | "providerId">,
  outcome: PoweroffAppResult["outcome"],
  result?: StopAppResult,
): PoweroffAppResult => ({
  ...target,
  outcome,
  ...(result?.servicesStopped === undefined ? {} : { servicesStopped: result.servicesStopped }),
  ...(result?.landofileEvents === undefined ? {} : { landofileEvents: result.landofileEvents }),
  ...(result?.shutdownObservations === undefined
    ? {}
    : { shutdownObservations: result.shutdownObservations }),
});

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
    const stopped = yield* stopAppAtRoot(target.appRoot, { providerId: target.providerId }).pipe(
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

  const globalTargetResult = yield* globalStopTarget().pipe(Effect.result);
  const globalTarget = Result.isSuccess(globalTargetResult) ? globalTargetResult.success : undefined;
  if (Result.isFailure(globalTargetResult))
    failures.push({
      kind: "global",
      appId: "global",
      appRoot: "",
      providerId: "global",
      error: globalTargetResult.failure,
    });
  const keepGlobal = options.keepGlobal === true;
  let globalStopped = false;
  if (globalTarget === undefined || keepGlobal || failures.length > 0) {
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

  if (failures.length > 0) {
    return yield* Effect.fail(
      new PoweroffStopError({
        message: `Failed to power off ${failures.length === 1 ? "one app" : `${failures.length} apps`}.`,
        remediation:
          "Resolve each reported failure and retry `lando poweroff`; the managed runtime was left running.",
        apps,
        failures: yield* stopEntries(failures),
      }),
    );
  }

  const runtimeService =
    !keepGlobal && globalStopped && keptScratch === 0
      ? yield* stopManagedRuntimeService
      : ({ terminated: false } satisfies RuntimeServiceStopResult);
  return {
    apps,
    keptGlobalApp: keepGlobal,
    keptScratchApps: keptScratch,
    runtimeServiceStopped: runtimeService.terminated,
    ...(runtimeService.pid === undefined ? {} : { runtimeServicePid: runtimeService.pid }),
  };
});

const globalStopTarget = Effect.fnUntraced(function* () {
  const app = yield* GlobalAppService;
  return { root: (yield* app.paths).root, providerId: yield* globalObserveProviderId };
});

const stopManagedRuntimeService: Effect.Effect<
  RuntimeServiceStopResult,
  never,
  ConfigService | PrivateFileAccessService
> = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(HostMaintenanceRegistry);
  if (Option.isNone(service)) return { terminated: false };
  const config = yield* ConfigService;
  const userDataRoot = yield* config.get("userDataRoot");
  if (userDataRoot === undefined) return { terminated: false };
  const privateFileAccess = yield* PrivateFileAccessService;
  const platform = normalizeHostPlatform();
  const paths = makeLandoPaths({ userDataRoot, platform });
  const stateStore = makeStateStore({ privateFileAccess, roots: paths.roots });
  const result = yield* teardownHostMaintainers(service.value, {
    paths,
    platform,
    privateFileAccess,
    stateStore,
  });
  return result satisfies RuntimeServiceStopResult;
});
