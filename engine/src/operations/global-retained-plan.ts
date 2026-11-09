import { ownsServiceContainer } from "@lando/container-runtime/native-ownership";
import { GlobalAppError } from "@lando/sdk/errors";
import { MessageInfoEvent } from "@lando/sdk/events";
import { type AppPlan, isActiveRunStatus, isIdleRunStatus } from "@lando/sdk/schema";
import {
  EventService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { DateTime, Effect, Option } from "effect";
import { resolveGlobalPlacement } from "../global-app/placement.ts";
import { readGlobalResolution } from "../global-app/resolution.ts";
import { prepareProvider } from "../providers/prepared.ts";
import { composeGlobalRecordedPlan } from "./global-recorded-plan.ts";
import { selectGlobalPlan } from "./global-selected-plan.ts";
import { globalSiblingConflicts } from "./global-sibling-conflicts.ts";

export { advanceGlobalRecordedPlan } from "./global-recorded-plan.ts";

export interface GlobalSiblingRemoval {
  readonly observation: ServiceRuntimeInfo;
  readonly binding: readonly string[];
}

export const reconcileGlobalSiblings = Effect.fn("GlobalApp.reconcileSiblings")(function* (
  desired: AppPlan,
  selectedProvider: RuntimeProviderShape,
  request: {
    readonly selectedIds: readonly string[];
    readonly close: (ids: ReadonlySet<string>) => Set<string>;
  },
) {
  const registry = yield* RuntimeProviderRegistry;
  yield* registry.assertAppliedStateReadable?.({ id: desired.id, provider: desired.provider }) ?? Effect.void;
  const { plan: prior } = yield* resolveGlobalPlacement();
  if (prior !== undefined && (prior.provider !== desired.provider || prior.root !== desired.root))
    return yield* Effect.fail(
      new GlobalAppError({
        operation: "start",
        message: `Global services ${request.selectedIds.join(", ")} have conflicting applied placement at ${prior.root} on ${prior.provider}.`,
        remediation:
          "Run `lando global:restart` to recreate every global service from its current definition.",
      }),
    );
  const provider = yield* prepareProvider(selectedProvider);
  const observed = (yield* provider.list({ app: desired.id, includeUnplanned: true })).filter(
    (service) =>
      service.app === desired.id && (service.appRoot === undefined || service.appRoot === desired.root),
  );
  const resolution = yield* readGlobalResolution({
    providerId: desired.provider,
    providerCapabilities: provider.capabilities,
  });
  const disabledIds = resolution.entries.filter((entry) => !entry.enabled).map((entry) => entry.id);
  const disabled = new Set(disabledIds);
  let selected = request.close(new Set(request.selectedIds));
  const initial = new Set(selected);
  const candidates = new Set(observed);
  const bindings: string[][] = [];
  const removals: GlobalSiblingRemoval[] = [];
  const joinNotices = new Map<string, string>();
  const removalNotices = new Map<string, string>();
  let changed = true;
  let failure: GlobalAppError | undefined;
  while (changed) {
    changed = false;
    failure = undefined;
    for (const observation of candidates) {
      const id = String(observation.service);
      if (selected.has(id)) continue;
      const active = isActiveRunStatus(observation.status);
      if (!ownsServiceContainer(desired, observation)) {
        if (active)
          failure = new GlobalAppError({
            operation: "start",
            message: `Global service ${id} is running in container ${observation.containerId ?? "(no id)"}, whose labels don't prove it belongs to this global app.`,
            remediation: `Inspect container ${observation.containerId ?? id} with your container runtime and remove it if it is a leftover, then retry.`,
          });
        continue;
      }
      const recorded = prior !== undefined && Object.hasOwn(prior.services, id);
      const selectable = Object.hasOwn(desired.services, id) && !disabled.has(id);
      const conflicts = recorded
        ? yield* globalSiblingConflicts(selectGlobalPlan(desired, selected), prior, {
            id,
            routes: active && !disabled.has(id),
          })
        : [];
      if (recorded && conflicts.length === 0) continue;
      const binding = [...new Set([id, ...conflicts.flatMap((conflict) => conflict.with)])];
      const older = conflicts.map((conflict) => conflict.reason).join(", ");
      if (active && selectable) {
        bindings.push(binding);
        joinNotices.set(
          id,
          recorded
            ? `Global service ${id} still uses ${older} from an older definition, so Lando is recreating it from its current definition.`
            : `Global service ${id} is running without saved state, so Lando is applying its current definition to it.`,
        );
        selected = request.close(new Set([...selected, id]));
        changed = true;
      } else if (isIdleRunStatus(observation.status) || (!recorded && active)) {
        // A leftover that conflicts with nothing is removed with the first requested service's group.
        const anchor = request.selectedIds[0];
        const removalBinding =
          conflicts.length > 0 ? binding : [id, ...(anchor === undefined ? selected : [anchor])];
        removals.push({ observation, binding: removalBinding });
        let why = "has no saved state";
        if (recorded) why = `still uses ${older} from an older definition`;
        else if (active)
          why = disabled.has(id)
            ? "has no saved state and is disabled"
            : "has no saved state or current definition";
        removalNotices.set(
          id,
          `Lando is removing the ${active ? "running" : "stopped"} ${id} container, which ${why}.${!active && selectable ? ` ${id} is created fresh the next time it starts, keeping its named volumes.` : ""}`,
        );
        candidates.delete(observation);
        changed = true;
      } else if (recorded) {
        let blocker = `its container is ${observation.status}`;
        if (disabled.has(id)) blocker = "it is disabled";
        else if (!Object.hasOwn(desired.services, id)) blocker = "it has no current definition";
        failure = new GlobalAppError({
          operation: "start",
          message: `Global service ${id} (container ${observation.containerId}) still uses ${older} from an older definition, and Lando can't recreate it because ${blocker}.`,
          remediation: `Run \`lando global:stop --service ${id}\`, then retry.`,
        });
      }
    }
  }
  if (failure !== undefined) return yield* Effect.fail(failure);
  const selectedPlan = selectGlobalPlan(desired, selected);
  const finalRemovals = removals.filter(({ observation }) => !selected.has(String(observation.service)));
  const removedIds = new Set(finalRemovals.map(({ observation }) => String(observation.service)));
  // Removal targets keep their recorded metadata until the group that removes them succeeds.
  const owned = observed.filter(
    (observation) =>
      ownsServiceContainer(desired, observation) &&
      Object.hasOwn(prior?.services ?? {}, String(observation.service)),
  );
  const recordedIds = new Set(owned.map((observation) => String(observation.service)));
  const retained = new Set([...recordedIds].filter((id) => !selected.has(id) && !removedIds.has(id)));
  // Selected services migrating off a shared resource must advance together, however they were selected.
  if (prior !== undefined)
    for (const observation of owned) {
      const id = String(observation.service);
      if (!selected.has(id)) continue;
      const conflicts = yield* globalSiblingConflicts(selectedPlan, prior, {
        id,
        routes: isActiveRunStatus(observation.status) && !disabled.has(id),
      });
      if (conflicts.length > 0)
        bindings.push([...new Set([id, ...conflicts.flatMap((conflict) => conflict.with)])]);
    }
  const active = new Set(
    owned
      .filter((observation) => isActiveRunStatus(observation.status))
      .map((observation) => String(observation.service)),
  );
  const empty = { ...selectGlobalPlan(prior ?? desired, new Set()), routes: [] };
  const recordedPlan =
    prior === undefined
      ? empty
      : yield* composeGlobalRecordedPlan(empty, prior, recordedIds, active, disabled);
  yield* composeGlobalRecordedPlan(selectedPlan, recordedPlan, retained, active, disabled);
  const events = yield* Effect.serviceOption(EventService);
  if (Option.isSome(events)) {
    // A removal candidate later pulled into the selection is started, not removed.
    const notices = [...joinNotices, ...[...removalNotices].filter(([id]) => removedIds.has(id))];
    for (const [, body] of notices.sort(([left], [right]) => left.localeCompare(right)))
      yield* events.value
        .publish(MessageInfoEvent.make({ body, timestamp: DateTime.nowUnsafe() }))
        .pipe(Effect.ignore);
  }
  return {
    provider,
    recordedPlan,
    disabledIds,
    retainedIds: [...retained].sort(),
    selectedIds: [...selected],
    joinedIds: [...selected].filter((id) => !initial.has(id)),
    bindings: [...bindings, ...finalRemovals.map((removal) => removal.binding)],
    removals: finalRemovals,
  };
});
