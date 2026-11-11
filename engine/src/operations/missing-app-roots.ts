import { type ProviderRuntimeSnapshot, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { TeardownProvider } from "../providers/app-placement.ts";
import type { MissingRootScan } from "./missing-app-root-schema.ts";
import { collectMissingAppRoots } from "./missing-root-candidates.ts";

export { MissingAppRoot } from "./missing-app-root-schema.ts";

export const scanMissingAppRoots = Effect.fn("AppOperation.scanMissingAppRoots")(function* () {
  const registry = yield* RuntimeProviderRegistry;
  const selected = yield* TeardownProvider;
  const ids = (yield* registry.list).filter((id) => selected === undefined || id === selected);
  const scans: (typeof MissingRootScan.Type)[] = [];
  const snapshots: ProviderRuntimeSnapshot[] = [];
  // Scope each scan so a broken provider cannot hide another provider's leftovers.
  for (const id of ids) {
    const state =
      registry.appliedStateInventory === undefined
        ? undefined
        : yield* registry.appliedStateInventory(id).pipe(Effect.result);
    const recordedState =
      state !== undefined &&
      Result.isSuccess(state) &&
      (state.success.plans.length > 0 || state.success.unreadable.length > 0);
    const result = yield* (
      registry.observeRuntime ??
      Effect.succeed([
        {
          providerId: id,
          runtimeObserved: false,
          appliedPlans: state !== undefined && Result.isSuccess(state) ? state.success.plans : [],
          services: [],
          volumes: [],
        },
      ])
    ).pipe(Effect.provideService(TeardownProvider, id), Effect.result);
    if (Result.isFailure(result)) {
      if (state !== undefined && Result.isSuccess(state))
        snapshots.push({
          providerId: id,
          runtimeObserved: false,
          appliedPlans: state.success.plans,
          services: [],
          volumes: [],
        });
      scans.push({
        providerId: id,
        runtimeObserved: false,
        recordedState,
        complete: false,
        message: result.failure.message,
        errorTag: result.failure._tag,
        remediation: result.failure.remediation,
      });
    } else {
      const providerSnapshots = result.success.filter((item) => item.providerId === id);
      snapshots.push(...providerSnapshots);
      const observed = providerSnapshots[0]?.runtimeObserved === true;
      const stateFailure = state !== undefined && Result.isFailure(state) ? state.failure : undefined;
      const unreadable = state !== undefined && Result.isSuccess(state) ? state.success.unreadable.length : 0;
      scans.push({
        providerId: id,
        runtimeObserved: observed,
        recordedState:
          recordedState ||
          providerSnapshots.some(
            (snapshot) => snapshot.appliedPlans.length > 0 || snapshot.volumes.length > 0,
          ),
        complete: observed && stateFailure === undefined && unreadable === 0,
        message:
          stateFailure?.message ??
          (unreadable > 0
            ? `${unreadable} applied-state records could not be read.`
            : observed
              ? "Runtime resources inspected."
              : "Runtime not observed; containers and volumes are not listed."),
        ...(stateFailure !== undefined
          ? { errorTag: stateFailure._tag, remediation: stateFailure.remediation }
          : unreadable > 0
            ? {
                errorTag: "AppResolveError",
                remediation: "Repair the unreadable applied-state records, then rerun apps:gc.",
              }
            : {}),
      });
    }
  }
  if (ids.length === 0 && selected === undefined && registry.observeRuntime !== undefined)
    snapshots.push(...(yield* registry.observeRuntime));
  const inventory = yield* collectMissingAppRoots(snapshots);
  for (const [id, failure] of inventory.capabilityFailures) {
    const index = scans.findIndex((scan) => scan.providerId === id);
    if (index < 0) scans.push(failure);
    else scans[index] = failure;
  }
  const recordedScans = yield* Effect.forEach(
    scans,
    Effect.fnUntraced(function* (scan) {
      const ownership = yield* (
        registry.hasRecordedOwnership?.(scan.providerId) ?? Effect.succeed(false)
      ).pipe(Effect.result);
      return {
        ...scan,
        recordedState:
          scan.recordedState ||
          inventory.journalProviders.has(scan.providerId) ||
          (Result.isSuccess(ownership) && ownership.success),
        ...(Result.isFailure(ownership)
          ? {
              complete: false,
              message: ownership.failure.message,
              errorTag: ownership.failure._tag,
              remediation: ownership.failure.remediation,
            }
          : {}),
      };
    }),
  );
  return { ...inventory, scans: recordedScans };
});

export const findMissingAppRoots = scanMissingAppRoots().pipe(Effect.map(({ candidates }) => candidates));
