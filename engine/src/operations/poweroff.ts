import { SCRATCH_LABEL } from "@lando/container-runtime/labels";
import { makeLandoPaths, normalizeHostPlatform } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import { AppResolveError, ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, ProviderId, StopAppResult } from "@lando/sdk/schema";
import {
  ConfigService,
  type FileSystem,
  GlobalAppService,
  type ProviderRuntimeSnapshot,
  RuntimeProviderRegistry,
  ScratchAppService,
  type ServiceRuntimeInfo,
  type StateStore,
} from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Option, Result, Schema } from "effect";
import { globalObserveProviderId } from "../global-app/placement.ts";
import { TeardownProvider } from "../providers/app-placement.ts";
import { taggedErrorRemediation } from "../providers/managed.ts";
import { HostMaintenanceRegistry, teardownHostMaintainers } from "../runtime/host-maintenance.ts";
import { readAcceleratedStartInventory } from "./accelerated-start-inventory.ts";
import { digest } from "./accelerated-start-record.ts";
import { appRootIdentityKey } from "./app-root-identity.ts";
import { type GlobalStopError, type GlobalStopServices, globalStop } from "./global-stop.ts";
import { type StopAppError, stopAppAtRoot } from "./stop.ts";

export const PoweroffAppKind = Schema.Literals(["user", "scratch", "global"]);
export const PoweroffAppOutcome = Schema.Literals(["stopped", "unchanged", "destroyed", "skipped"]);

export const PoweroffAppResultSchema = Schema.Struct({
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

export const PoweroffStopFailureSchema = Schema.Struct({
  kind: PoweroffAppKind,
  appId: Schema.String,
  appRoot: Schema.String,
  providerId: Schema.String,
  errorTag: Schema.String,
  message: Schema.String,
  remediation: Schema.NonEmptyString,
});

export type PoweroffStopFailure = typeof PoweroffStopFailureSchema.Type;

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
type UserTarget = {
  readonly providerId: ProviderId;
  readonly appRoot: AbsolutePath;
  readonly appId: AppId;
};
type ScratchTarget = {
  readonly id: string;
  readonly appRoot: AbsolutePath;
  readonly providerId: ProviderId;
};

const ACTIVE_SERVICE_STATUSES: ReadonlySet<ServiceRuntimeInfo["status"]> = new Set([
  "running",
  "paused",
  "restarting",
  "created",
]);

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
  return {
    ...target,
    errorTag: failureTag(error),
    message: yield* redacted(failureMessage(error)),
    remediation: yield* redacted(failureRemediation(error)),
  } satisfies PoweroffStopFailure;
});

const stopEntries = (failures: ReadonlyArray<StopFailure>): Effect.Effect<PoweroffStopFailure[]> =>
  Effect.forEach(failures, (failure) => stopFailure(failure, failure.error), { concurrency: 1 });

const appResult = (
  target: {
    readonly kind: PoweroffAppResult["kind"];
    readonly appId: string;
    readonly appRoot: string;
    readonly providerId: string;
  },
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

const providerInventoryFailure = (
  providerId: string,
  error: unknown,
  kind: PoweroffAppResult["kind"] = "user",
): StopFailure => ({ kind, appId: providerId, appRoot: "", providerId, error });

const unreadableAppliedState = (providerId: ProviderId, count: number) =>
  new ProviderUnavailableError({
    providerId,
    operation: "applied-state.list",
    message: `${count} applied-state records could not be read.`,
    remediation:
      "Restore a readable applied-state record from a trusted backup or remove the corrupt file, then retry `lando poweroff`.",
  });

const userTargetKey = (providerId: ProviderId, appRoot: AbsolutePath): string =>
  `${String(providerId)}\0${appRoot}`;

const collectInventory = Effect.gen(function* () {
  const registry = yield* RuntimeProviderRegistry;
  const failures: StopFailure[] = [];
  const snapshots: ProviderRuntimeSnapshot[] = [];
  const idsResult = yield* registry.list.pipe(Effect.result);
  const ids = Result.isSuccess(idsResult) ? idsResult.success : [];
  if (Result.isFailure(idsResult)) failures.push(providerInventoryFailure("providers", idsResult.failure));

  for (const id of ids) {
    const state =
      registry.appliedStateInventory === undefined
        ? undefined
        : yield* registry.appliedStateInventory(id).pipe(Effect.result);
    if (state !== undefined && Result.isFailure(state))
      failures.push(providerInventoryFailure(String(id), state.failure));
    if (state !== undefined && Result.isSuccess(state) && state.success.unreadable.length > 0)
      failures.push(
        providerInventoryFailure(String(id), unreadableAppliedState(id, state.success.unreadable.length)),
      );
    // Scope each observation so a broken provider cannot hide another provider's workloads.
    const observed = yield* (registry.observeRuntime ?? Effect.succeed([])).pipe(
      Effect.provideService(TeardownProvider, id),
      Effect.result,
    );
    if (Result.isFailure(observed)) {
      failures.push(providerInventoryFailure(String(id), observed.failure));
      continue;
    }
    snapshots.push(...observed.success.filter((snapshot) => snapshot.providerId === id));
  }

  return { snapshots, failures };
});

export const poweroff = Effect.fn("AppsPoweroff.poweroff")(function* (
  options: PoweroffOptions = {},
): Effect.fn.Return<PoweroffResult, PoweroffError, PoweroffServices> {
  const inventory = yield* collectInventory;
  const failures: StopFailure[] = [...inventory.failures];
  const apps: PoweroffAppResult[] = [];

  const userTargets = new Map<string, UserTarget>();
  const scratchObserved = new Map<string, ScratchTarget>();
  for (const snapshot of inventory.snapshots) {
    for (const service of snapshot.services) {
      if (service.app === "global") continue;
      if (service.labels?.[SCRATCH_LABEL] === "TRUE") {
        if (ACTIVE_SERVICE_STATUSES.has(service.status))
          scratchObserved.set(String(service.app), {
            id: String(service.app),
            appRoot: service.appRoot ?? AbsolutePath.make(""),
            providerId: service.providerId,
          });
        continue;
      }
      if (!ACTIVE_SERVICE_STATUSES.has(service.status)) continue;
      if (service.appRoot === undefined) {
        failures.push({
          kind: "user",
          appId: String(service.app),
          appRoot: "",
          providerId: String(service.providerId),
          error: new AppResolveError({
            reason: "missing-root",
            detail: "container-root",
            message: `The container for ${service.app}/${service.service} has no proven app root.`,
            remediation:
              "Restore the container's app-root label or remove it through its owning provider, then retry `lando poweroff`.",
          }),
        });
        continue;
      }
      const key = userTargetKey(service.providerId, service.appRoot);
      if (!userTargets.has(key))
        userTargets.set(key, {
          providerId: service.providerId,
          appRoot: service.appRoot,
          appId: service.app,
        });
    }
  }

  const journals = yield* readAcceleratedStartInventory(false).pipe(Effect.result);
  if (Result.isFailure(journals)) failures.push(providerInventoryFailure("journals", journals.failure));
  else {
    for (const journal of journals.success.records) {
      if (journal.appId === "global") continue;
      const ref = {
        kind: "user" as const,
        id: AppId.make(journal.appId),
        root: AbsolutePath.make(journal.appRoot),
      };
      // The filename binds app kind and root; scratch journals never contribute a user target.
      if (!journal.path.endsWith(`${digest(appRootIdentityKey(ref, journal.appRoot))}.json`)) continue;
      const key = userTargetKey(ProviderId.make(journal.providerId), ref.root);
      if (!userTargets.has(key))
        userTargets.set(key, {
          providerId: ProviderId.make(journal.providerId),
          appRoot: ref.root,
          appId: ref.id,
        });
    }
  }

  const userOrder = [...userTargets.values()].sort((left, right) =>
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

  const scratches = yield* ScratchAppService;
  const scratchList = yield* scratches.list().pipe(Effect.result);
  const scratchTargets = new Map(scratchObserved);
  if (Result.isSuccess(scratchList)) {
    for (const summary of scratchList.success) {
      if (!scratchTargets.has(summary.id))
        scratchTargets.set(summary.id, {
          id: summary.id,
          appRoot: summary.app.root,
          providerId: scratchObserved.get(summary.id)?.providerId ?? ProviderId.make("lando"),
        });
    }
  } else {
    failures.push({
      kind: "scratch",
      appId: "scratch",
      appRoot: "",
      providerId: "lando",
      error: scratchList.failure,
    });
  }

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

  const globalTarget = yield* globalStopTarget(inventory.snapshots);
  const keepGlobal = options.keepGlobal === true;
  let globalStopped = false;
  if (keepGlobal || failures.length > 0) {
    apps.push(
      appResult(
        {
          kind: "global",
          appId: "global",
          appRoot: globalTarget.root,
          providerId: String(globalTarget.providerId),
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
          {
            app: stopped.success.app,
            outcome: stopped.success.outcome,
            servicesStopped: stopped.success.servicesStopped,
            ...(stopped.success.shutdownObservations === undefined
              ? {}
              : { shutdownObservations: stopped.success.shutdownObservations }),
          },
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

const globalStopTarget = Effect.fnUntraced(function* (snapshots: ReadonlyArray<ProviderRuntimeSnapshot>) {
  const plan = snapshots
    .flatMap((snapshot) => snapshot.appliedPlans)
    .find((candidate) => candidate.id === "global");
  if (plan !== undefined) return { root: plan.identity?.appRoot ?? plan.root, providerId: plan.provider };
  const service = snapshots
    .flatMap((snapshot) => snapshot.services)
    .find((candidate) => candidate.app === "global" && candidate.appRoot !== undefined);
  if (service?.appRoot !== undefined) return { root: service.appRoot, providerId: service.providerId };
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
