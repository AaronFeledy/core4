import { mapFailures } from "@lando/sdk/command-result";
import { GlobalAppError, type StateStoreError } from "@lando/sdk/errors";
import { GlobalAppService, StateStore, type StateWrite } from "@lando/sdk/services";
import { Effect, Result, Schema } from "effect";

export const GlobalReconciliationPhase = Schema.Literals(["evidence", "containers", "routes", "generation"]);

export const GlobalReconciliationPending = Schema.Struct({
  phase: GlobalReconciliationPhase,
  services: Schema.Array(Schema.String),
  message: Schema.String,
});
export type GlobalReconciliationPending = typeof GlobalReconciliationPending.Type;

type Phase = GlobalReconciliationPending["phase"];

/** Independent obligations: clearing one phase proves nothing about another. */
export const pendingOperations = {
  // A command replaces its selection; generation always describes the whole configuration.
  reconciliation: {
    adds: ["evidence", "containers", "routes", "generation"],
    clears: ["evidence", "containers", "routes", "generation"],
  },
  policy: { adds: ["evidence", "routes", "generation"], clears: [] },
  receiptFailure: { adds: ["evidence"], clears: [] },
  evidence: { adds: ["evidence"], clears: ["evidence"] },
  discovery: { adds: ["containers", "routes"], clears: [] },
  containers: { adds: ["containers"], clears: ["containers"] },
  routes: { adds: [], clears: ["routes"] },
  generation: { adds: [], clears: ["generation"] },
  resources: { adds: [], clears: ["evidence", "containers", "routes"] },
} as const satisfies Readonly<
  Record<string, { readonly adds: readonly Phase[]; readonly clears: readonly Phase[] }>
>;

export const pendingWork = (
  phase: Phase,
  services: ReadonlyArray<string>,
  message: string,
): GlobalReconciliationPending => ({ phase, services: [...services], message });

/** Validate requested edits, including idempotent ones, before changing any obligation. */
export const transitionGlobalPending = (
  pending: ReadonlyArray<GlobalReconciliationPending>,
  operation: keyof typeof pendingOperations,
  change: {
    readonly adds?: ReadonlyArray<GlobalReconciliationPending>;
    readonly clears?: ReadonlyArray<{ readonly phase: Phase; readonly services?: ReadonlyArray<string> }>;
  },
): Result.Result<ReadonlyArray<GlobalReconciliationPending>, GlobalAppError> => {
  const allowed: { readonly adds: readonly Phase[]; readonly clears: readonly Phase[] } =
    pendingOperations[operation];
  for (const action of ["adds", "clears"] as const) {
    for (const { phase } of change[action] ?? []) {
      if (!allowed[action].includes(phase))
        return Result.fail(
          new GlobalAppError({
            operation,
            message: `Global reconciliation operation ${operation} cannot ${action === "adds" ? "add" : "clear"} phase ${phase}.`,
            remediation: "Repair the reconciliation caller to use the operation that owns this obligation.",
          }),
        );
    }
  }
  const retained = pending.flatMap((entry) => {
    let services = entry.services;
    for (const clear of change.clears ?? []) {
      if (clear.phase !== entry.phase) continue;
      const selected = clear.services;
      if (selected === undefined) return [];
      services = services.filter((id) => !selected.includes(id));
      if (services.length === 0) return [];
    }
    return services === entry.services ? [entry] : [{ ...entry, services }];
  });
  return Result.succeed([...retained, ...(change.adds ?? [])]);
};

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
export const GLOBAL_RECONCILIATION_VERSION = 1;

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
      version: GLOBAL_RECONCILIATION_VERSION,
      mode: 0o600,
      lock: "advisory",
      onCorrupt: "fail",
      default: emptyState(),
    })
    .pipe(mapFailures(receiptError));
});

export const readGlobalReconciliation = Effect.fn("GlobalApp.readReconciliation")(function* () {
  const bucket = yield* reconciliationBucket();
  return (yield* bucket.get.pipe(mapFailures(receiptError))) ?? emptyState();
});

/**
 * Apply one obligation change under the receipt lock and return the stored receipt.
 * `undefined` keeps the receipt unwritten; `existing` is false until one is saved.
 */
const updateReconciliation = Effect.fn("GlobalApp.updateReconciliation")(function* (
  update: (
    previous: GlobalReconciliationState,
    existing: boolean,
  ) => Result.Result<GlobalReconciliationState | undefined, GlobalAppError>,
) {
  const bucket = yield* reconciliationBucket();
  return yield* bucket
    .mutate((stored) => {
      const previous = stored ?? emptyState();
      return bucket.exists.pipe(
        Effect.flatMap((existing) => Effect.fromResult(update(previous, existing))),
        Effect.map(
          (next): StateWrite<GlobalReconciliationState, GlobalReconciliationState> =>
            next === undefined
              ? { _tag: "Keep", result: previous }
              : { _tag: "Set", value: next, result: next },
        ),
      );
    })
    .pipe(Effect.catchTag("StateStoreError", (cause) => Effect.fail(receiptError(cause))));
});

/**
 * Cleanup records only change an existing receipt. Checking before taking the lock keeps
 * observation-only teardown from creating the global root just to hold the lock file.
 */
const whenRecorded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  reconciliationBucket().pipe(
    Effect.flatMap((bucket) => bucket.exists.pipe(mapFailures(receiptError))),
    Effect.flatMap((exists) => (exists ? Effect.asVoid(effect) : Effect.void)),
  );

/** Keep pending work for other selections; each command replaces only its own receipt. */
export const recordGlobalReconciliation = Effect.fn("GlobalApp.recordReconciliation")(function* (
  next: GlobalReconciliationState,
  options: { readonly supersede?: ReadonlyArray<string> } = {},
) {
  // Receipt replacement scope does not establish ownership for resource cleanup.
  const selected = new Set(options.supersede ?? next.contributions);
  const services = [...selected];
  return yield* updateReconciliation((previous) =>
    transitionGlobalPending(previous.pending, "reconciliation", {
      clears: [
        { phase: "generation" },
        ...(["evidence", "containers", "routes"] as const).map((phase) => ({
          phase,
          services,
        })),
      ],
      adds: next.pending,
    }).pipe(
      Result.map((pending) => {
        const pendingIds = new Set(pending.flatMap((entry) => entry.services));
        return {
          ...next,
          ...(previous.routesClearedRevision === next.revision
            ? { routesClearedRevision: previous.routesClearedRevision }
            : {}),
          targets: [
            ...(previous.targets ?? []).filter((target) => !selected.has(target.id)),
            ...(next.targets ?? []),
          ].filter((target) => pendingIds.has(target.id)),
          pending,
        };
      }),
    ),
  );
});

/** Configuration regeneration may finish without completing previously pending container cleanup. */
export const recordGlobalGeneration = Effect.fn("GlobalApp.recordGeneration")(function* (revision: number) {
  yield* whenRecorded(
    updateReconciliation((previous) =>
      previous.pending.every((entry) => entry.phase !== "generation")
        ? Result.succeed(undefined)
        : transitionGlobalPending(previous.pending, "generation", { clears: [{ phase: "generation" }] }).pipe(
            Result.map((pending) => ({ ...previous, revision, pending })),
          ),
    ),
  );
});

/** Whole-app teardown proves container and route cleanup without changing saved intent. */
export const recordGlobalResourceCleanup = Effect.fn("GlobalApp.recordResourceCleanup")(function* () {
  yield* whenRecorded(
    updateReconciliation((previous, existing) =>
      !existing
        ? Result.succeed(undefined)
        : transitionGlobalPending(previous.pending, "resources", {
            clears: [{ phase: "evidence" }, { phase: "containers" }, { phase: "routes" }],
          }).pipe(
            Result.map((pending) => ({
              ...previous,
              routesClearedRevision: previous.revision,
              targets: [],
              pending,
            })),
          ),
    ),
  );
});

/** Route-only recovery cannot prove that unknown container ownership has been resolved. */
export const recordGlobalRouteCleanup = Effect.fn("GlobalApp.recordRouteCleanup")(function* () {
  yield* whenRecorded(
    updateReconciliation((previous, existing) =>
      !existing
        ? Result.succeed(undefined)
        : transitionGlobalPending(previous.pending, "routes", { clears: [{ phase: "routes" }] }).pipe(
            Result.map((pending) => ({ ...previous, routesClearedRevision: previous.revision, pending })),
          ),
    ),
  );
});
