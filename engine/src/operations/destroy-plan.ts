import { basename } from "node:path";
import type { DestroyAppOptions } from "@lando/sdk/app";
import { AppResolveError, FileSyncStopError } from "@lando/sdk/errors";
import type { PreDestroyEvent } from "@lando/sdk/events";
import {
  type AbsolutePath,
  AppId,
  type AppRef,
  type ResourceOwnership,
  type SnapshotInfo,
} from "@lando/sdk/schema";
import { type AppliedOrphanGroup, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Result } from "effect";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { resolveMysqlVolumeTarget } from "../planner/mysql-volume.ts";
import { pendingStartDisposal, readDiscardableStart } from "./accelerated-start-disposal.ts";
import type { TeardownResolution } from "./applied-state-target.ts";
import { ownedSnapshots } from "./destroy-snapshots.ts";
import { type LandofileEventPlan, resolveLandofileEventPlan } from "./landofile-events.ts";

/** Read-only evidence for one invocation, never a fabricated desired/applied plan. */
export type TeardownPlan = {
  readonly evidence: PreDestroyEvent["evidence"] | undefined;
  readonly root: AbsolutePath;
  readonly name: string;
  readonly refs: ReadonlyArray<AppRef>;
  readonly applied: ResolvedAppTarget | undefined;
  /**
   * The Landofile hooks for an applied teardown, resolved from the Landofile at the applied root.
   * Undefined for retained recovery: that target is the desired plan itself, so its Landofile
   * loaded, and the executor runs no authored steps while disposing an unfinished start.
   */
  readonly authored: LandofileEventPlan | undefined;
  readonly retained: ResolvedAppTarget | undefined;
  readonly target: ResolvedAppTarget | undefined;
  readonly groups: ReadonlyArray<AppliedOrphanGroup>;
  readonly inventory: ReadonlyArray<ResourceOwnership>;
  readonly snapshots: ReadonlyArray<SnapshotInfo>;
  readonly followUpOrphans: boolean;
  readonly options: DestroyAppOptions;
};

export const uniqueDestroyRefs = (refs: ReadonlyArray<AppRef>): ReadonlyArray<AppRef> => [
  ...new Map(refs.map((ref) => [`${ref.kind}\0${ref.id}\0${ref.root}`, ref])).values(),
];

export const planUserTeardown = Effect.fn("AppOperation.planUserTeardown")(function* <E, R>(
  resolution: TeardownResolution,
  options: DestroyAppOptions,
  request: {
    readonly desired: Effect.Effect<ResolvedAppTarget | undefined, E, R>;
    readonly snapshotRoots?: ReadonlyArray<AbsolutePath>;
    readonly missingRoot?: boolean;
  },
) {
  let applied: ResolvedAppTarget | undefined;
  let groups: ReadonlyArray<AppliedOrphanGroup> = [];
  let inventory: ReadonlyArray<ResourceOwnership> = [];
  let landofilePresent = false;
  let root: AbsolutePath;
  switch (resolution.kind) {
    case "applied":
      applied = resolution.target;
      root = applied.root;
      inventory = resolution.ownership ?? [];
      landofilePresent = request.missingRoot !== true;
      break;
    case "orphans":
      groups = resolution.groups;
      inventory = resolution.ownership ?? [];
      root = resolution.root;
      landofilePresent = resolution.landofilePresent;
      break;
    case "owned":
      inventory = resolution.ownership;
      root = resolution.root;
      landofilePresent = resolution.landofilePresent;
      break;
    case "absent":
      root = resolution.root;
      landofilePresent = resolution.landofilePresent;
      break;
    default: {
      const unreachable: never = resolution;
      return unreachable;
    }
  }
  const snapshots =
    options.purgeSnapshots === true ? yield* ownedSnapshots(request.snapshotRoots ?? [root]) : [];
  const recorded = uniqueDestroyRefs([
    ...(applied === undefined ? [] : [applied.app]),
    ...groups.map((group): AppRef => ({ kind: "user", id: group.appId, root })),
    ...inventory.flatMap((hint) =>
      hint.appIds.map((id): AppRef => ({ kind: "user", id, root: hint.appRoot })),
    ),
    ...snapshots.map((info): AppRef => ({ kind: "user", id: info.store.app, root: info.owner.appRoot })),
  ]);
  const desiredResult =
    recorded.length === 0 && request.missingRoot !== true
      ? yield* request.desired.pipe(Effect.result)
      : undefined;
  const desired = desiredResult === undefined ? undefined : Result.getOrUndefined(desiredResult);
  const journalRefs = uniqueDestroyRefs([
    { kind: "user", id: AppId.make(root), root },
    ...recorded,
    ...(desired === undefined ? [] : [desired.app]),
  ]);
  // The accelerated-start journal is keyed by app root, so read it once per distinct root.
  const journalRoots = [...new Map(journalRefs.map((ref) => [ref.root, ref])).values()];
  const pending = yield* Effect.forEach(journalRoots, (app) =>
    readDiscardableStart(app).pipe(Effect.map(({ pending }) => ({ app, pending }))),
  );
  const unfinished = pending.filter(({ pending }) => pending !== null && pending.phase !== "completed");
  let retained: ResolvedAppTarget | undefined;
  const first = unfinished[0];
  if (first !== undefined) {
    retained =
      desiredResult === undefined
        ? yield* request.desired.pipe(Effect.catch(() => Effect.succeed(undefined)))
        : desired;
    if (unfinished.length !== 1 || retained === undefined) {
      return yield* Effect.fail(
        new FileSyncStopError({
          engineId: first.pending?.engineId ?? "unavailable",
          sessionRef: first.pending?.appId ?? first.app.id,
          message: "Retained sync state cannot be matched to a readable app plan for safe destroy.",
          remediation: "Restore the matching Landofile and retry destroy.",
        }),
      );
    }
    if (
      retained.root !== root ||
      retained.app.id !== first.pending?.appId ||
      (applied !== undefined && retained.app.id !== applied.app.id)
    ) {
      return yield* Effect.fail(
        new AppResolveError({
          reason: "mismatch",
          detail: "app-ref",
          message: "The desired app identity differs from retained runtime state.",
          remediation: "Restore the matching app plan before destroying retained sync state.",
        }),
      );
    }
    yield* pendingStartDisposal(retained.app, retained.plan);
  }
  if (desiredResult !== undefined && Result.isFailure(desiredResult) && !landofilePresent)
    return yield* Effect.fail(desiredResult.failure);
  const authored =
    applied !== undefined && retained === undefined ? yield* resolveLandofileEventPlan(applied) : undefined;
  const registry = yield* RuntimeProviderRegistry;
  if (desired !== undefined) yield* registry.assertAppliedStateReadable?.(desired.plan) ?? Effect.void;
  const disposal = retained ?? applied;
  const target = disposal === undefined ? undefined : yield* resolveMysqlVolumeTarget(disposal, registry);
  const refs = uniqueDestroyRefs([...recorded, ...(retained === undefined ? [] : [retained.app])]);
  if (inventory.length > 0 && refs.length === 0)
    return yield* Effect.fail(
      new AppResolveError({
        reason: "mismatch",
        detail: "app-ref",
        message: "The ownership inventory has no recorded app identity.",
        remediation: "Repair the provider ownership inventory before retrying destroy.",
      }),
    );
  return {
    evidence:
      retained !== undefined
        ? "retained"
        : applied !== undefined
          ? "applied"
          : groups.length > 0
            ? "orphans"
            : inventory.length > 0
              ? "inventory"
              : snapshots.length > 0
                ? "snapshots"
                : undefined,
    root,
    name:
      applied?.plan.name ?? retained?.plan.name ?? recorded[0]?.id ?? desired?.plan.name ?? basename(root),
    refs,
    applied,
    authored,
    retained,
    target,
    groups,
    inventory,
    snapshots,
    followUpOrphans: request.missingRoot === true && applied !== undefined,
    options,
  } satisfies TeardownPlan;
});
