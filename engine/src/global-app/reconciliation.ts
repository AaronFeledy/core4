import { Effect, Schema } from "effect";

import { GlobalAppError, type StateStoreError } from "@lando/sdk/errors";
import { GlobalAppService, StateStore } from "@lando/sdk/services";

export const GlobalReconciliationPhase = Schema.Literals(["evidence", "containers", "routes", "generation"]);

export const GlobalReconciliationPending = Schema.Struct({
  phase: GlobalReconciliationPhase,
  services: Schema.Array(Schema.String),
  message: Schema.String,
});
export type GlobalReconciliationPending = typeof GlobalReconciliationPending.Type;

export const GlobalReconciliationTarget = Schema.Struct({
  id: Schema.String,
  plugin: Schema.String,
  root: Schema.String,
  provider: Schema.String,
  appliedServiceHash: Schema.String,
});
export type GlobalReconciliationTarget = typeof GlobalReconciliationTarget.Type;

export const GlobalReconciliationState = Schema.Struct({
  targets: Schema.optionalKey(Schema.Array(GlobalReconciliationTarget)),
  routesClearedRevision: Schema.optionalKey(Schema.Number),
  revision: Schema.Number,
  operation: Schema.optionalKey(Schema.Literals(["enable", "disable", "reconcile"])),
  contributions: Schema.Array(Schema.String),
  servicesRemoved: Schema.Array(Schema.String),
  pending: Schema.Array(GlobalReconciliationPending),
});
export type GlobalReconciliationState = typeof GlobalReconciliationState.Type;

const emptyState = (): GlobalReconciliationState => ({
  revision: 0,
  contributions: [],
  servicesRemoved: [],
  pending: [],
});

const receiptError = (cause: StateStoreError): GlobalAppError =>
  new GlobalAppError({
    operation: "reconciliation",
    message: "Unable to read or save global service reconciliation state.",
    remediation: "Repair access to the global app state directory, then repeat the policy command.",
    cause,
  });

const reconciliationBucket = Effect.fn("GlobalApp.reconciliationBucket")(function* () {
  const globalApp = yield* GlobalAppService;
  const paths = yield* globalApp.paths;
  const store = yield* StateStore;
  return yield* store
    .open({
      root: { app: paths.root },
      key: ".lando.reconciliation.json",
      schema: GlobalReconciliationState,
      version: 1,
      mode: 0o600,
      lock: "advisory",
      onCorrupt: "fail",
      default: emptyState(),
    })
    .pipe(Effect.mapError(receiptError));
});

export const readGlobalReconciliation = Effect.fn("GlobalApp.readReconciliation")(function* () {
  const bucket = yield* reconciliationBucket();
  if (!(yield* bucket.exists.pipe(Effect.mapError(receiptError)))) return emptyState();
  return (yield* bucket.get.pipe(Effect.mapError(receiptError))) ?? emptyState();
});

/** Keep pending work for other selections; each command replaces only its own receipt. */
export const recordGlobalReconciliation = Effect.fn("GlobalApp.recordReconciliation")(function* (
  next: GlobalReconciliationState,
) {
  const bucket = yield* reconciliationBucket();
  const selected = new Set(next.contributions);
  return yield* bucket
    .update((previous) => {
      const pending = [
        ...(previous?.pending ?? []).flatMap((entry) => {
          if (entry.phase === "generation") return [];
          const services = entry.services.filter((id) => !selected.has(id));
          return services.length === 0 ? [] : [{ ...entry, services }];
        }),
        ...next.pending,
      ];
      const pendingIds = new Set(pending.flatMap((entry) => entry.services));
      return {
        ...next,
        ...(previous?.routesClearedRevision === next.revision
          ? { routesClearedRevision: previous.routesClearedRevision }
          : {}),
        targets: [
          ...(previous?.targets ?? []).filter((target) => !selected.has(target.id)),
          ...(next.targets ?? []),
        ].filter((target) => pendingIds.has(target.id)),
        pending,
      };
    })
    .pipe(Effect.mapError(receiptError));
});

/** Configuration regeneration may finish without completing previously pending container cleanup. */
export const recordGlobalGeneration = Effect.fn("GlobalApp.recordGeneration")(function* (revision: number) {
  const bucket = yield* reconciliationBucket();
  if (!(yield* bucket.exists.pipe(Effect.mapError(receiptError)))) return;
  const current = yield* bucket.get.pipe(Effect.mapError(receiptError));
  if (current === null || current.pending.every((entry) => entry.phase !== "generation")) return;
  yield* bucket
    .update((previous) => ({
      ...(previous ?? emptyState()),
      revision,
      pending: (previous?.pending ?? []).filter((entry) => entry.phase !== "generation"),
    }))
    .pipe(Effect.mapError(receiptError));
});

/** Whole-app teardown proves container and route cleanup without changing saved intent. */
export const recordGlobalResourceCleanup = Effect.fn("GlobalApp.recordResourceCleanup")(function* () {
  const bucket = yield* reconciliationBucket();
  if (!(yield* bucket.exists.pipe(Effect.mapError(receiptError)))) return;
  const current = yield* bucket.get.pipe(Effect.mapError(receiptError));
  if (current === null) return;
  yield* bucket
    .update((previous) => ({
      ...(previous ?? emptyState()),
      routesClearedRevision: previous?.revision ?? 0,
      targets: [],
      pending: (previous?.pending ?? []).filter((entry) => entry.phase === "generation"),
    }))
    .pipe(Effect.mapError(receiptError));
});

/** Route-only recovery cannot prove that unknown container ownership has been resolved. */
export const recordGlobalRouteCleanup = Effect.fn("GlobalApp.recordRouteCleanup")(function* () {
  const bucket = yield* reconciliationBucket();
  if (!(yield* bucket.exists.pipe(Effect.mapError(receiptError)))) return;
  const current = yield* bucket.get.pipe(Effect.mapError(receiptError));
  if (current === null) return;
  yield* bucket
    .update((previous) => ({
      ...(previous ?? emptyState()),
      routesClearedRevision: previous?.revision ?? 0,
      pending: (previous?.pending ?? []).filter((entry) => entry.phase !== "routes"),
    }))
    .pipe(Effect.mapError(receiptError));
});
