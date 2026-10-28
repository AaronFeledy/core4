import { FileSyncStartError, FileSyncStopError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type AppPlan,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
  type FileSyncSessionSpec,
  ServiceName,
  plannedFileSyncSessions,
} from "@lando/sdk/schema";
import { type FileSyncEngineShape, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestFileSyncEngine } from "@lando/sdk/test";
import { DateTime, Effect, Layer } from "effect";
import { FileSyncResolver } from "../../src/plugins/file-sync-resolver.ts";
import { acceleratedPlan, app } from "./accelerated-start-recovery-support.ts";
import { makeHarness } from "./start-progress-topology-support.ts";

export const syncPlan = (plan: AppPlan): AppPlan => ({
  ...plan,
  fileSync: (plannedFileSyncSessions(plan) ?? []).map((entry) => ({
    engineId: "mutagen",
    session: {
      app,
      service: ServiceName.make(entry.service),
      mountKey: entry.mountKey,
      source: AbsolutePath.make(entry.source),
      target: { _tag: "volume", name: entry.volumeName, path: entry.targetPath },
      mode: "two-way-safe",
      excludes: entry.excludes,
    },
  })),
});

const web = acceleratedPlan.services[ServiceName.make("web")];
if (web === undefined) throw new TypeError("Missing fixture service");
export const oldPlan = syncPlan({
  ...acceleratedPlan,
  services: {
    [ServiceName.make("web")]: { ...web, user: "1000:1000" },
    [ServiceName.make("worker")]: {
      ...web,
      name: ServiceName.make("worker"),
      primary: false,
      user: "1001:1001",
    },
  },
});
export const changedPlan = syncPlan({
  ...oldPlan,
  services: Object.fromEntries(
    Object.entries(oldPlan.services).map(([name, service]) => [
      name,
      {
        ...service,
        user: "2000:2000",
        mounts: service.mounts.map((mount) =>
          mount.type === "bind" ? { ...mount, excludes: ["vendor"] } : mount,
        ),
      },
    ]),
  ),
});
export const targetFor = (plan: AppPlan) => ({ app, root: plan.root, plan });

export type FailurePoint =
  | "quiesce"
  | "drain"
  | "conflict"
  | "dispose"
  | "targets"
  | "complete"
  | "retire"
  | "retire-after"
  | "prepare"
  | "flush";

export const withEngineId = (plan: AppPlan, engineId: string): AppPlan => ({
  ...plan,
  fileSync: plan.fileSync.map((entry) => ({ ...entry, engineId })),
});

export const ordinaryPlan: AppPlan = {
  ...oldPlan,
  services: Object.fromEntries(
    Object.entries(oldPlan.services).map(([name, service]) => [
      name,
      {
        ...service,
        mounts: service.mounts.map((mount) => {
          if (mount.type !== "bind" || mount.realization !== "accelerated") return mount;
          const { mountKey: _mountKey, realization: _realization, ...bind } = mount;
          return { ...bind, realization: "passthrough" as const };
        }),
      },
    ]),
  ),
  fileSync: [],
};

export const rotationHarness = Effect.fnUntraced(function* (
  options: {
    readonly desired?: AppPlan;
    readonly failAt?: FailurePoint;
    readonly extraSession?: boolean;
    readonly missingSession?: boolean;
    readonly fresh?: boolean;
    readonly unknownApplied?: boolean;
    /** When set, the injected FileSyncEngine id (defaults to mutagen / applied). */
    readonly injectedEngineId?: string;
    /** Optional second engine used only when desired.engineId differs from applied. */
    readonly alternateEngines?: ReadonlyArray<FileSyncEngineShape>;
  } = {},
) {
  const desired = options.desired ?? changedPlan;
  const calls: string[] = [];
  const cleanedPlans: AppPlan[] = [];
  let applied: AppPlan | undefined = options.fresh ? undefined : oldPlan;
  let phase: "absent" | "active" | "drained" | "disposing" | "completed" = "active";
  let failure = options.failAt;
  const trip = (point: FailurePoint) =>
    Effect.suspend(() => {
      if (failure !== point) return Effect.void;
      failure = undefined;
      return Effect.interrupt;
    });
  const info = (spec: FileSyncSessionSpec, ref: string): FileSyncSessionInfo => ({
    ...spec,
    spec,
    ref: FileSyncSessionRef.make(ref),
    status: "running",
    lastUpdatedAt: DateTime.makeUnsafe("2026-01-01"),
  });
  const sessions = options.fresh
    ? []
    : oldPlan.fileSync.map(({ session }) => info(session, `old-${session.service}`));
  if (options.extraSession && sessions[0] !== undefined)
    sessions.push(info({ ...sessions[0].spec, mountKey: "foreign" }, "foreign"));
  if (options.missingSession) sessions.pop();
  const primaryEngineId = options.injectedEngineId ?? "mutagen";
  const engine: FileSyncEngineShape = {
    ...TestFileSyncEngine,
    id: primaryEngineId,
    sessionsPersistAcrossProcesses: true,
    isAvailable: Effect.succeed(true),
    listSessions: (filter) =>
      Effect.sync(() =>
        sessions.filter(
          ({ spec }) =>
            (filter.service === undefined || filter.service === spec.service) &&
            (filter.mountKey === undefined || filter.mountKey === spec.mountKey),
        ),
      ),
    appLifecycle: {
      disposalPhase: () => Effect.sync(() => phase),
      invalidateDrain: () =>
        Effect.suspend(() => {
          calls.push("invalidate");
          if (phase === "completed" && sessions.length === 0) return Effect.die("stale drain");
          phase = "active";
          return Effect.void;
        }),
      drain: () =>
        Effect.gen(function* () {
          calls.push("drain");
          yield* trip("drain");
          if (failure === "conflict") {
            failure = undefined;
            return yield* Effect.fail(
              new FileSyncStopError({
                engineId: "mutagen",
                sessionRef: "old-web",
                message: "Conflicting writes",
                remediation: "Preserve both versions and resolve the conflict.",
              }),
            );
          }
          phase = "drained";
        }),
      dispose: () =>
        Effect.gen(function* () {
          calls.push("dispose");
          phase = "disposing";
          sessions.pop();
          yield* trip("dispose");
          sessions.splice(0);
        }),
      completeDisposal: () =>
        Effect.gen(function* () {
          calls.push("complete");
          yield* trip("complete");
          phase = "completed";
        }),
    },
    createSession: (spec) =>
      Effect.sync(() => {
        calls.push(`create:${spec.service}`);
        phase = "active";
        const ref = `new-${spec.service}`;
        sessions.push(info(spec, ref));
        return FileSyncSessionRef.make(ref);
      }),
    flushSession: () => trip("flush"),
  };
  const harness = makeHarness({
    plannedApp: desired,
    fileSync: engine,
    onPublish: (event) =>
      Effect.sync(() => {
        if (event._tag === "pre-init") calls.push("init");
      }),
  });
  const base = yield* harness.runtimeProviderRegistry.select();
  const provider = {
    ...base,
    inspectAppliedFileSync: () =>
      Effect.sync(() =>
        options.unknownApplied
          ? { status: "unknown" as const }
          : applied === undefined
            ? { status: "missing" as const }
            : applied.fileSync.length === 0
              ? { status: "ordinary" as const }
              : {
                  status: "accelerated" as const,
                  engineId: applied.fileSync[0]?.engineId ?? primaryEngineId,
                  sessions: applied.fileSync.map(({ session }) => session),
                },
      ),
    quiesceForFileSync: ({ plan }: { readonly plan?: AppPlan }) =>
      Effect.gen(function* () {
        calls.push("quiesce");
        if (plan !== oldPlan) return yield* Effect.die("quiesced desired plan");
        yield* trip("quiesce");
      }),
    disposeFileSyncTargets: (plan: AppPlan) =>
      Effect.gen(function* () {
        calls.push("targets");
        cleanedPlans.push(plan);
        yield* trip("targets");
      }),
    destroy: (selector: Parameters<typeof base.destroy>[0], opts: Parameters<typeof base.destroy>[1]) =>
      Effect.gen(function* () {
        calls.push("retire");
        if (selector.plan !== oldPlan || opts.volumes || opts.purgeCaches || opts.removeState !== true)
          return yield* Effect.die("unsafe retirement");
        yield* trip("retire");
        applied = undefined;
        yield* trip("retire-after");
        return { kind: "destroyed" as const };
      }),
    prepareFileSyncTargets: (plan: AppPlan) =>
      Effect.gen(function* () {
        calls.push("prepare");
        yield* trip("prepare");
        if (base.prepareFileSyncTargets === undefined) return yield* Effect.die("no prepare hook");
        return yield* base.prepareFileSyncTargets(plan);
      }),
    apply: (plan: AppPlan, opts: Parameters<typeof base.apply>[1]) =>
      base.apply(plan, opts).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            calls.push("apply");
            applied = plan;
          }),
        ),
      ),
  };
  const enginesById = new Map<string, FileSyncEngineShape>([
    [engine.id, engine],
    ...(options.alternateEngines ?? []).map((entry) => [entry.id, entry] as const),
  ]);
  const resolver = FileSyncResolver.of({
    candidates: [...enginesById.values()].map((entry) => ({
      id: entry.id,
      pluginName: "test",
      source: "test",
      capabilities: entry.capabilities,
      supports: { platform: ["linux", "darwin", "win32"] },
    })),
    select: () => Effect.succeed(undefined),
    acquire: (id: string) =>
      Effect.suspend(() => {
        const found = enginesById.get(id);
        if (found !== undefined) return Effect.succeed(found);
        return Effect.fail(
          new FileSyncStartError({
            engineId: id,
            message: `No file-sync engine is available for "${id}".`,
            remediation: "Select or restore the planned file-sync engine before retrying.",
          }),
        );
      }),
  });
  const layer = Layer.mergeAll(
    harness.layer,
    Layer.succeed(RuntimeProviderRegistry, {
      ...harness.runtimeProviderRegistry,
      select: () => Effect.succeed(provider),
      resolveAppliedPlan: () => Effect.sync(() => applied),
    }),
    Layer.succeed(FileSyncResolver, resolver),
  );
  return {
    ...harness,
    layer,
    calls,
    sessions,
    cleanedPlans,
    desired,
    applied: () => applied,
    phase: () => phase,
  };
});
