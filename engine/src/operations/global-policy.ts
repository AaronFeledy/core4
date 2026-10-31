import { Effect, Schema } from "effect";

import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { GlobalAppError } from "@lando/sdk/errors";
import { AppId, type AppPlan, type ServiceConfig, ServicePlan } from "@lando/sdk/schema";
import { GlobalAppService, RouterService, RuntimeProviderRegistry } from "@lando/sdk/services";

import {
  activeGlobalPolicyChange,
  globalActivationEpoch,
  withGlobalActivationPolicyGate,
  withGlobalPolicyChange,
} from "../global-app/activation-scope.ts";
import { commitGlobalPolicy, prepareGlobalPolicy } from "../global-app/enablement.ts";
import { GlobalPolicyReconciliationError } from "../global-app/errors.ts";
import { withGlobalMutation } from "../global-app/mutation.ts";
import { globalCreateProviderId, resolveGlobalPlacement } from "../global-app/placement.ts";
import {
  GlobalReconciliationPending,
  type GlobalReconciliationTarget,
  readGlobalReconciliation,
  recordGlobalReconciliation,
} from "../global-app/reconciliation.ts";
import {
  GlobalContributionStateSchema,
  type GlobalResolution,
  assertGlobalResolution,
  projectEffectiveGlobalResolution,
  readGlobalResolution,
} from "../global-app/resolution.ts";
import { withReadOnlyLandofile } from "../services/landofile-live.ts";
import { readGlobalConsumerReservations } from "./global-consumer-lease.ts";
import {
  GlobalConsumerProtectionError,
  GlobalConsumerSchema,
  readGlobalConsumerImpact,
} from "./global-consumers.ts";
import { GlobalDistResultSchema, validateGlobalConfiguration } from "./global-install.ts";
import { type GlobalTeardown, resolveGlobalStopSelection, resolveGlobalTeardown } from "./global-teardown.ts";

export type GlobalPolicyChangeOptions = {
  readonly selectors?: ReadonlyArray<string>;
  readonly all?: boolean;
  readonly dryRun?: boolean;
  readonly allowDisruption?: boolean;
};

export const GlobalPolicyImpactSchema = Schema.Struct({
  desired: Schema.Literals(["enabled", "disabled", "unchanged"]),
  policyChanges: Schema.Boolean,
  contributions: Schema.Array(Schema.String),
  plugins: Schema.Array(Schema.String),
  dependencyBlockers: Schema.Array(Schema.String),
  consumers: Schema.Array(GlobalConsumerSchema),
  allowDisruption: Schema.Boolean,
  routes: Schema.Array(Schema.Struct({ service: Schema.String, hostname: Schema.String })),
  volumes: Schema.Literal("retained"),
  uncertainties: Schema.Array(Schema.String),
  validationErrors: Schema.Array(Schema.String),
});

export const GlobalPolicyChangeResultSchema = Schema.Struct({
  dryRun: Schema.Boolean,
  impact: GlobalPolicyImpactSchema,
  operation: Schema.Literals(["enable", "disable", "reconcile"]),
  revision: Schema.Number,
  policySaved: Schema.Boolean,
  contributions: Schema.Array(Schema.String),
  plugins: Schema.Array(Schema.String),
  states: Schema.Array(GlobalContributionStateSchema),
  servicesRemoved: Schema.Array(Schema.String),
  dist: Schema.optionalKey(GlobalDistResultSchema),
  pending: Schema.Array(GlobalReconciliationPending),
});
export type GlobalPolicyChangeResult = typeof GlobalPolicyChangeResultSchema.Type;

type Operation = GlobalPolicyChangeResult["operation"];
type Pending = typeof GlobalReconciliationPending.Type;

const pendingWork = (phase: Pending["phase"], services: ReadonlyArray<string>, message: string): Pending => ({
  phase,
  services: [...services],
  message,
});

const dependencyBlockers = (
  resolution: GlobalResolution,
  selected: ReadonlySet<string>,
  applied?: AppPlan,
  authored?: Readonly<Record<string, ServiceConfig>>,
): ReadonlyArray<string> => {
  const enabled = new Map(resolution.entries.map((entry) => [entry.id, entry.enabled]));
  const blockers = new Set<string>();
  for (const entry of resolution.entries) {
    if (!entry.enabled || selected.has(entry.id) || Object.hasOwn(authored ?? {}, entry.id)) continue;
    if (entry.requiredServices.some((dependency) => selected.has(dependency))) blockers.add(entry.id);
  }
  for (const service of Object.values(applied?.services ?? {})) {
    if (selected.has(service.name)) continue;
    if (
      service.dependsOn.some(
        (dependency) => dependency.required !== false && selected.has(dependency.service),
      )
    )
      blockers.add(service.name);
  }
  for (const [id, service] of Object.entries(authored ?? {})) {
    if (selected.has(id) || enabled.get(id) === false) continue;
    if (
      service.dependsOn?.some(
        (dependency) => dependency.required !== false && selected.has(dependency.service),
      )
    )
      blockers.add(id);
  }
  return [...blockers].sort();
};

const dependencyError = (blockers: ReadonlyArray<string>): GlobalAppError =>
  new GlobalAppError({
    operation: "disable",
    message: `Global services still require the selected contribution: ${blockers.join(", ")}.`,
    remediation:
      "Select the dependent contributions as well, choose their owning plugin, or remove the authored dependency before disabling its service.",
  });

const providerOnline = Effect.fn("GlobalPolicy.providerOnline")(function* (resolved: GlobalTeardown) {
  if (!(yield* resolved.provider.isAvailable)) return false;
  return (yield* resolved.provider.getStatus).running;
});

const serviceFingerprint = (service: typeof ServicePlan.Type): string =>
  sha256Hex(canonicalJson({ ...Schema.encodeSync(ServicePlan)(service), routes: undefined }));

const recordProgress = (
  receipt: GlobalPolicyChangeResult,
  targets: ReadonlyArray<GlobalReconciliationTarget>,
) =>
  recordGlobalReconciliation({
    revision: receipt.revision,
    targets: receipt.operation === "enable" ? [] : targets,
    operation: receipt.operation,
    contributions: receipt.contributions,
    servicesRemoved: receipt.servicesRemoved,
    pending: receipt.pending,
  });

const incomplete = (
  receipt: GlobalPolicyChangeResult,
  causes: ReadonlyArray<unknown>,
): GlobalPolicyReconciliationError =>
  new GlobalPolicyReconciliationError({
    message: "Global service policy is saved, but reconciliation still has pending work.",
    operation: receipt.operation,
    policySaved: true,
    revision: receipt.revision,
    contributions: receipt.contributions,
    plugins: receipt.plugins,
    servicesRemoved: receipt.servicesRemoved,
    pending: receipt.pending,
    causes: [...causes],
    remediation:
      "Inspect global:status for saved policy and running resources. Fix the reported cause, then run `lando global:reconcile`; it preserves policy and starts no containers. If a pending service no longer has current ownership metadata, restore its owning plugin and matching applied state, or explicitly stop the whole global app.",
  });

const changePolicy = Effect.fn("GlobalPolicy.change")(function* (
  operation: Operation,
  options: GlobalPolicyChangeOptions = {},
) {
  const previousReceiptResult = yield* Effect.result(readGlobalReconciliation());
  const previousReceipt =
    previousReceiptResult._tag === "Success" ? previousReceiptResult.success : { pending: [] };
  const current = yield* readGlobalResolution();
  const prepared = yield* prepareGlobalPolicy(
    current.policy,
    current.contributions,
    operation === "reconcile"
      ? undefined
      : {
          selectors: options.selectors ?? [],
          ...(options.all === undefined ? {} : { all: options.all }),
          enabled: operation === "enable",
        },
  );
  const candidate = yield* readGlobalResolution({ policy: prepared.policy });
  // Read applied metadata without constructing the runtime before calculating impact.
  const placement = yield* Effect.result(resolveGlobalPlacement());
  const applied = placement._tag === "Success" ? placement.success.plan : undefined;
  const composition =
    operation === "enable" ? undefined : yield* Effect.result(validateGlobalConfiguration(current));
  const authored = composition?._tag === "Success" ? composition.success.services : undefined;
  const currentIds = new Set(candidate.entries.map((entry) => entry.id));
  const retiredTargets =
    operation === "reconcile"
      ? (previousReceiptResult._tag === "Success"
          ? (previousReceiptResult.success.targets ?? [])
          : []
        ).filter((target) => {
          if (
            currentIds.has(target.id) ||
            applied === undefined ||
            authored === undefined ||
            Object.hasOwn(authored, target.id)
          )
            return false;
          const owner = prepared.policy.plugins[target.plugin];
          const preference = owner?.contributions[target.id];
          if (preference === undefined || (preference.enabled ?? owner?.enabled ?? preference.defaultEnabled))
            return false;
          const service = Object.values(applied.services).find((entry) => String(entry.name) === target.id);
          return (
            service !== undefined &&
            applied.root === target.root &&
            String(applied.provider) === target.provider &&
            serviceFingerprint(service) === target.appliedServiceHash
          );
        })
      : [];
  const supersededTargets =
    operation === "enable"
      ? (previousReceiptResult._tag === "Success"
          ? (previousReceiptResult.success.targets ?? [])
          : []
        ).filter((target) => {
          if (
            !(
              options.all ||
              options.selectors?.includes(target.plugin) ||
              options.selectors?.includes(target.id)
            )
          )
            return false;
          const owner = prepared.policy.plugins[target.plugin];
          const preference = owner?.contributions[target.id];
          return (
            preference !== undefined && (preference.enabled ?? owner?.enabled ?? preference.defaultEnabled)
          );
        })
      : [];
  const ids =
    operation === "reconcile"
      ? [
          ...new Set([
            ...candidate.entries.filter((entry) => !entry.enabled).map((entry) => entry.id),
            ...retiredTargets.map((target) => target.id),
          ]),
        ].sort()
      : [...new Set([...prepared.ids, ...supersededTargets.map((target) => target.id)])].sort();
  const selected = new Set(ids);
  const targets: ReadonlyArray<GlobalReconciliationTarget> = [
    ...retiredTargets,
    ...ids.flatMap((id) => {
      const owner = candidate.entries.find((entry) => entry.id === id);
      const service = Object.values(applied?.services ?? {}).find((entry) => String(entry.name) === id);
      return owner === undefined || service === undefined || applied === undefined
        ? []
        : [
            {
              id,
              plugin: owner.plugin,
              root: applied.root,
              provider: String(applied.provider),
              appliedServiceHash: serviceFingerprint(service),
            },
          ];
    }),
  ];
  const observedApplied =
    operation !== "enable" && applied !== undefined
      ? yield* Effect.result(
          Effect.gen(function* () {
            const registry = yield* RuntimeProviderRegistry;
            const provider = yield* registry.select(applied.provider);
            if (!(yield* provider.isAvailable) || !(yield* provider.getStatus).running) return undefined;
            const observations = yield* provider.list({ app: applied.id, includeUnplanned: true });
            const active = new Set(
              observations
                .filter(
                  (service) =>
                    service.appRoot === applied.root &&
                    service.providerId === applied.provider &&
                    ["running", "paused", "restarting"].includes(service.status),
                )
                .map((service) => String(service.service)),
            );
            return {
              ...applied,
              services: Object.fromEntries(Object.entries(applied.services).filter(([id]) => active.has(id))),
            };
          }),
        )
      : undefined;
  const blockers =
    operation === "enable"
      ? []
      : dependencyBlockers(
          candidate,
          selected,
          observedApplied?._tag === "Success" ? observedApplied.success : undefined,
          authored,
        );
  const validation =
    operation === "enable"
      ? yield* Effect.result(
          Effect.gen(function* () {
            yield* assertGlobalResolution(candidate, ids, { directOnly: true });
            return yield* validateGlobalConfiguration(candidate);
          }),
        )
      : undefined;
  const effectiveCandidate = projectEffectiveGlobalResolution(
    candidate,
    validation?._tag === "Success" ? validation.success.services : (authored ?? candidate.composableServices),
    validation?._tag === "Success"
      ? validation.success.pendingSites
      : composition?._tag === "Success"
        ? composition.success.pendingSites
        : [],
  );
  const activationEpoch = yield* globalActivationEpoch;
  const consumerImpact =
    operation === "enable"
      ? { consumers: [], uncertainties: [] }
      : yield* readGlobalConsumerImpact({
          selectedIds: ids,
          ...(placement._tag === "Success"
            ? { providerId: placement.success.realized ?? placement.success.desired }
            : {}),
          routerId: (yield* RouterService).id,
        });
  const reservations =
    operation === "enable" ? undefined : yield* Effect.result(readGlobalConsumerReservations(ids));
  const reserved =
    reservations?._tag === "Success"
      ? reservations.success.map(
          (reservation) =>
            `Activation of ${reservation.app.kind} ${reservation.app.id} (${reservation.app.root}) reserves ${reservation.services.filter((id) => selected.has(id)).join(", ")}; retry after startup completes.`,
        )
      : reservations?._tag === "Failure"
        ? [reservations.failure.message]
        : [];
  const activePolicy = options.dryRun ? yield* activeGlobalPolicyChange : undefined;
  const impact: typeof GlobalPolicyImpactSchema.Type = {
    desired: operation === "enable" ? "enabled" : operation === "disable" ? "disabled" : "unchanged",
    policyChanges: prepared.changed,
    contributions: ids,
    plugins: prepared.plugins,
    dependencyBlockers: blockers,
    consumers: consumerImpact.consumers,
    allowDisruption: options.allowDisruption === true,
    routes: (applied?.routes ?? [])
      .filter((route) => selected.has(String(route.service)))
      .map((route) => ({ service: String(route.service), hostname: route.hostname })),
    volumes: "retained",
    uncertainties: [
      ...reserved,
      ...(activePolicy === undefined
        ? []
        : [`Global policy ${activePolicy} is still reconciling; retry after it completes.`]),
      ...consumerImpact.uncertainties,
      ...(placement._tag === "Failure" ? ["Applied ownership metadata could not be read."] : []),
      ...(applied !== undefined &&
      operation !== "enable" &&
      (observedApplied?._tag !== "Success" || observedApplied.success === undefined)
        ? ["Applied runtime state and active reverse dependencies could not be observed."]
        : []),
      ...(applied === undefined && ids.length > 0
        ? ["No matching applied plan proves selected containers or routes."]
        : []),
      ...(composition?._tag === "Failure"
        ? ["Current authored dependency configuration could not be read."]
        : []),
      ...((previousReceiptResult._tag === "Success"
        ? (previousReceiptResult.success.targets ?? [])
        : []
      ).some(
        (target) => !currentIds.has(target.id) && !retiredTargets.some((retired) => retired.id === target.id),
      )
        ? [
            "A retired cleanup target no longer has matching applied and authored ownership evidence; restore that evidence or explicitly stop the whole global app.",
          ]
        : []),
      ...(previousReceiptResult._tag === "Failure"
        ? ["Previous reconciliation state could not be read."]
        : []),
    ],
    validationErrors: validation?._tag === "Failure" ? [validation.failure.message] : [],
  };
  if (options.dryRun)
    return {
      dryRun: true,
      impact,
      operation,
      revision: current.policy.revision,
      policySaved: false,
      contributions: ids,
      plugins: prepared.plugins,
      states: effectiveCandidate.entries.filter((entry) => selected.has(entry.id)),
      servicesRemoved: [],
      pending: [],
    } satisfies GlobalPolicyChangeResult;
  if (validation?._tag === "Failure") return yield* Effect.fail(validation.failure);
  if (operation !== "enable" && reserved.length > 0)
    return yield* Effect.fail(
      new GlobalConsumerProtectionError({
        operation,
        policySaved: false,
        consumers: [],
        uncertainties: reserved,
        message: "Application activation reserves the selected global services; policy was left unchanged.",
        remediation:
          "Wait for application startup to complete, then retry. --allow-disruption cannot invalidate an active startup admission.",
      }),
    );
  if (blockers.length > 0) return yield* Effect.fail(dependencyError(blockers));
  if (
    operation !== "enable" &&
    options.allowDisruption !== true &&
    (consumerImpact.consumers.length > 0 || consumerImpact.uncertainties.length > 0)
  )
    return yield* Effect.fail(
      new GlobalConsumerProtectionError({
        operation,
        policySaved: false,
        message:
          consumerImpact.consumers.length > 0
            ? "Running applications require the selected global services; policy was left unchanged."
            : "Running application dependencies could not be verified; policy was left unchanged.",
        consumers: consumerImpact.consumers,
        uncertainties: consumerImpact.uncertainties,
        remediation:
          "Stop or reconfigure the named applications and restore any unreadable evidence, then retry. Use --allow-disruption only when you intend to continue despite these consumers or uncertainties; the acknowledgement applies to this invocation.",
      }),
    );
  const policy = yield* withGlobalActivationPolicyGate(
    Effect.gen(function* () {
      if (operation !== "enable" && (yield* globalActivationEpoch) !== activationEpoch)
        return yield* Effect.fail(
          new GlobalConsumerProtectionError({
            operation,
            policySaved: false,
            consumers: [],
            uncertainties: [
              "Application activation changed during the consumer impact scan; retry to inspect the current running applications.",
            ],
            message: "Application activity changed during validation; policy was left unchanged.",
            remediation: "Retry this command after application startup completes.",
          }),
        );
      const active = operation === "enable" ? [] : yield* readGlobalConsumerReservations(ids);
      if (operation !== "enable" && active.length > 0)
        return yield* Effect.fail(
          new GlobalConsumerProtectionError({
            operation,
            policySaved: false,
            consumers: [],
            uncertainties: active.map(
              (reservation) =>
                `Activation of ${reservation.app.kind} ${reservation.app.id} (${reservation.app.root}) reserves ${reservation.services.filter((id) => selected.has(id)).join(", ")}; retry after startup completes.`,
            ),
            message:
              "Application activation reserves the selected global services; policy was left unchanged.",
            remediation:
              "Wait for application startup to complete, then retry. --allow-disruption cannot invalidate an active startup admission.",
          }),
        );
      return yield* commitGlobalPolicy(current.policy.revision, prepared.policy);
    }),
  );
  const priorRouteIds =
    operation === "enable"
      ? []
      : [
          ...new Set(
            previousReceipt.pending
              .filter((entry) => entry.phase === "routes")
              .flatMap((entry) => entry.services.filter((id) => selected.has(id))),
          ),
        ];
  let routesAttempted = false;
  let receipt: GlobalPolicyChangeResult = {
    dryRun: false,
    impact,
    operation,
    revision: policy.revision,
    policySaved: true,
    contributions: ids,
    plugins: prepared.plugins,
    states: effectiveCandidate.entries.filter((entry) => selected.has(entry.id)),
    servicesRemoved: [],
    pending: [
      ...(operation === "enable" || ids.length === 0
        ? []
        : [pendingWork("evidence", ids, "Selected cleanup has not yet acquired ownership evidence.")]),
      ...(priorRouteIds.length === 0
        ? []
        : [
            pendingWork(
              "routes",
              priorRouteIds,
              "Earlier route withdrawal is still unconfirmed; applied-plan changes do not complete it.",
            ),
          ]),
      pendingWork("generation", ids, "Generated configuration has not yet been reconciled."),
    ],
  };
  const causes: unknown[] = [];
  const marked = yield* Effect.result(recordProgress(receipt, targets));
  if (marked._tag === "Failure") return yield* Effect.fail(incomplete(receipt, [marked.failure]));

  if (operation !== "enable" && ids.length > 0) {
    const cleanup = yield* Effect.result(resolveGlobalTeardown());
    receipt = { ...receipt, pending: receipt.pending.filter((entry) => entry.phase !== "evidence") };
    if (cleanup._tag === "Failure") {
      causes.push(cleanup.failure);
      receipt = {
        ...receipt,
        pending: [
          ...receipt.pending,
          pendingWork("evidence", ids, "Applied ownership could not be read; selected cleanup has not run."),
        ],
      };
    } else {
      const resolved = cleanup.success;
      const online = yield* Effect.result(providerOnline(resolved));
      if (online._tag === "Failure" || !online.success) {
        if (online._tag === "Failure") causes.push(online.failure);
        receipt = {
          ...receipt,
          pending: [
            ...receipt.pending,
            pendingWork(
              "evidence",
              ids,
              "The applied provider is unreachable; selected containers and routes are unverified.",
            ),
          ],
        };
      } else if (resolved.evidence.kind === "applied") {
        const appliedPlan = resolved.evidence.plan;
        const appliedNames = new Set(
          Object.values(resolved.evidence.plan.services).map((service) => String(service.name)),
        );
        const appliedIds = ids.filter((id) => appliedNames.has(id));
        const inventory = yield* Effect.result(
          resolved.provider.list({ app: AppId.make("global"), includeUnplanned: true }),
        );
        const uncertainSelected =
          inventory._tag === "Failure" ||
          inventory.success.some(
            (service) =>
              selected.has(String(service.service)) &&
              service.app === AppId.make("global") &&
              (service.appRoot === undefined ||
                (service.appRoot === resolved.paths.root &&
                  (service.providerId !== appliedPlan.provider ||
                    service.containerId === undefined ||
                    !appliedNames.has(String(service.service))))),
          );
        if (inventory._tag === "Failure") causes.push(inventory.failure);
        const active = new Set(
          inventory._tag === "Success"
            ? inventory.success
                .filter(
                  (service) =>
                    service.app === appliedPlan.id &&
                    service.appRoot === resolved.paths.root &&
                    service.providerId === appliedPlan.provider &&
                    service.containerId !== undefined &&
                    ["running", "paused", "restarting"].includes(service.status),
                )
                .map((service) => String(service.service))
            : [],
        );
        const blockers = dependencyBlockers(
          candidate,
          selected,
          {
            ...appliedPlan,
            services: Object.fromEntries(
              Object.entries(appliedPlan.services).filter(([id]) => active.has(id)),
            ),
          },
          authored,
        );
        const unknownObserved =
          inventory._tag === "Success" &&
          inventory.success.some(
            (service) =>
              service.app === appliedPlan.id &&
              !selected.has(String(service.service)) &&
              (service.appRoot === undefined ||
                (service.appRoot === resolved.paths.root &&
                  (service.providerId !== appliedPlan.provider ||
                    service.containerId === undefined ||
                    !appliedNames.has(String(service.service))))) &&
              ["running", "paused", "restarting"].includes(service.status),
          );
        const unknownDependents = candidate.entries.filter(
          (entry) =>
            entry.enabled &&
            !selected.has(entry.id) &&
            entry.dependencyEvidence === "unavailable" &&
            !appliedNames.has(entry.id) &&
            inventory._tag === "Success" &&
            inventory.success.some(
              (service) =>
                String(service.service) === entry.id &&
                (service.appRoot === resolved.paths.root || service.appRoot === undefined),
            ),
        );
        if (blockers.length > 0 || unknownDependents.length > 0 || uncertainSelected || unknownObserved) {
          if (blockers.length > 0) causes.push(dependencyError(blockers));
          receipt = {
            ...receipt,
            pending: [
              ...receipt.pending,
              pendingWork(
                "evidence",
                ids,
                uncertainSelected || unknownObserved
                  ? "Runtime ownership or dependency evidence is incomplete; restore matching applied state before selected cleanup."
                  : unknownDependents.length > 0
                    ? "Dependency evidence is unavailable for enabled contributions outside the applied plan; cleanup needs matching applied state."
                    : "Applied dependents require an expanded selection before cleanup.",
              ),
            ],
          };
        } else if (appliedIds.length === 0) {
          const observed = yield* Effect.result(
            resolved.provider.list({ app: AppId.make("global"), includeUnplanned: true }),
          );
          if (
            observed._tag === "Failure" ||
            observed.success.some(
              (service) =>
                selected.has(String(service.service)) &&
                (service.appRoot === resolved.paths.root ||
                  (service.app === AppId.make("global") && service.appRoot === undefined)),
            )
          ) {
            if (observed._tag === "Failure") causes.push(observed.failure);
            receipt = {
              ...receipt,
              pending: [
                ...receipt.pending,
                pendingWork(
                  "evidence",
                  ids,
                  "Selected resources cannot be matched to the applied plan; cleanup needs ownership recovery.",
                ),
              ],
            };
          }
        } else {
          const selection = yield* Effect.result(
            resolveGlobalStopSelection(resolved, appliedIds, { requireOnline: true }),
          );
          if (selection._tag === "Failure") {
            causes.push(selection.failure);
            receipt = {
              ...receipt,
              pending: [
                ...receipt.pending,
                pendingWork("evidence", ids, "Selected owned containers could not be observed."),
              ],
            };
          } else {
            const remaining = new Map(
              selection.success.services.map((service) => [service.containerId, String(service.service)]),
            );
            receipt = {
              ...receipt,
              pending: [
                ...receipt.pending,
                ...(remaining.size === 0
                  ? []
                  : [
                      pendingWork(
                        "containers",
                        [...new Set(remaining.values())],
                        "Selected containers have not all been removed.",
                      ),
                    ]),
                ...(selection.success.routes === undefined ||
                receipt.pending.some((entry) => entry.phase === "routes")
                  ? []
                  : [pendingWork("routes", appliedIds, "Selected routes have not yet been withdrawn.")]),
              ],
            };
            const cleanupMarked = yield* Effect.result(recordProgress(receipt, targets));
            if (cleanupMarked._tag === "Failure")
              return yield* Effect.fail(incomplete(receipt, [...causes, cleanupMarked.failure]));
            for (const service of selection.success.services) {
              const removal = yield* Effect.result(resolved.provider.removeObservedService(service));
              if (removal._tag === "Failure") causes.push(removal.failure);
              else {
                remaining.delete(service.containerId);
                if (removal.success.kind === "removed")
                  receipt = {
                    ...receipt,
                    servicesRemoved: [...receipt.servicesRemoved, String(service.service)],
                  };
              }
              receipt = {
                ...receipt,
                pending: [
                  ...receipt.pending.filter((entry) => entry.phase !== "containers"),
                  ...(remaining.size === 0
                    ? []
                    : [
                        pendingWork(
                          "containers",
                          [...new Set(remaining.values())],
                          "Selected containers could not all be removed.",
                        ),
                      ]),
                ],
              };
              const progress = yield* Effect.result(recordProgress(receipt, targets));
              if (progress._tag === "Failure")
                return yield* Effect.fail(incomplete(receipt, [...causes, progress.failure]));
            }
            if (selection.success.routePolicyError !== undefined) {
              routesAttempted = true;
              causes.push(selection.success.routePolicyError);
            } else if (selection.success.routes !== undefined) {
              const router = yield* RouterService;
              const excluded = new Set(
                candidate.entries.filter((entry) => !entry.enabled).map((entry) => entry.id),
              );
              const routes = selection.success.routes.filter((route) => !excluded.has(String(route.service)));
              routesAttempted = true;
              const withdrawn = yield* Effect.result(router.applyRoutes(routes, selection.success.plan.id));
              if (withdrawn._tag === "Failure") causes.push(withdrawn.failure);
              else
                receipt = {
                  ...receipt,
                  pending: receipt.pending.filter((entry) => entry.phase !== "routes"),
                };
            }
          }
        }
        if (
          !routesAttempted &&
          priorRouteIds.length > 0 &&
          inventory._tag === "Success" &&
          !receipt.pending.some((entry) => entry.phase === "evidence")
        ) {
          const disabled = new Set(
            candidate.entries.filter((entry) => !entry.enabled).map((entry) => entry.id),
          );
          const routes = appliedPlan.routes.filter(
            (route) =>
              !selected.has(String(route.service)) &&
              !disabled.has(String(route.service)) &&
              active.has(String(route.service)),
          );
          const router = yield* RouterService;
          routesAttempted = true;
          const withdrawn = yield* Effect.result(router.applyRoutes(routes, appliedPlan.id));
          if (withdrawn._tag === "Failure") causes.push(withdrawn.failure);
          else receipt = { ...receipt, pending: receipt.pending.filter((entry) => entry.phase !== "routes") };
        }
      } else if (resolved.evidence.kind !== "absent") {
        receipt = {
          ...receipt,
          pending: [
            ...receipt.pending,
            pendingWork(
              "routes",
              ids,
              "Historical routes cannot be verified without a matching applied plan. Restore applied state or explicitly stop the whole global app before retrying.",
            ),
            pendingWork(
              "evidence",
              ids,
              "Runtime resources lack a matching applied plan; ownership and routes need recovery before selected cleanup.",
            ),
          ],
        };
      } else {
        if (
          (resolved.materialized &&
            (previousReceiptResult._tag !== "Success" ||
              previousReceiptResult.success.routesClearedRevision !== policy.revision)) ||
          previousReceipt.pending.some(
            (entry) => entry.phase === "routes" && entry.services.some((id) => selected.has(id)),
          )
        ) {
          receipt = {
            ...receipt,
            pending: [
              ...receipt.pending,
              pendingWork(
                "routes",
                ids,
                "Historical routes cannot be verified without a matching applied plan. Restore applied state or explicitly stop the whole global app before retrying.",
              ),
            ],
          };
        }
        const observed = yield* Effect.result(
          resolved.provider.list({ app: AppId.make("global"), includeUnplanned: true }),
        );
        if (observed._tag === "Failure") {
          causes.push(observed.failure);
          receipt = {
            ...receipt,
            pending: [
              ...receipt.pending,
              pendingWork(
                "evidence",
                ids,
                "Runtime observations are unavailable; cleanup cannot be confirmed.",
              ),
            ],
          };
        } else if (
          observed.success.some(
            (service) =>
              selected.has(String(service.service)) &&
              (service.appRoot === resolved.paths.root ||
                (service.app === AppId.make("global") && service.appRoot === undefined)),
          )
        ) {
          receipt = {
            ...receipt,
            pending: [
              ...receipt.pending,
              pendingWork(
                "evidence",
                ids,
                "Selected runtime observations lack matching applied ownership; cleanup cannot be confirmed until their root and provider evidence are restored.",
              ),
            ],
          };
        }
      }
    }
  }

  // Configuration errors in another contribution cannot prevent selected container cleanup.
  const generation = yield* Effect.result(
    Effect.gen(function* () {
      const runtime = yield* Effect.result(
        Effect.gen(function* () {
          const registry = yield* RuntimeProviderRegistry;
          const providerId = yield* globalCreateProviderId();
          return { providerId, provider: yield* registry.select(providerId) };
        }),
      );
      const resolved = yield* readGlobalResolution(
        runtime._tag === "Success"
          ? {
              policy,
              providerId: runtime.success.providerId,
              providerCapabilities: runtime.success.provider.capabilities,
            }
          : { policy },
      );
      yield* assertGlobalResolution(resolved, undefined, { directOnly: true });
      const globalApp = yield* GlobalAppService;
      yield* Effect.scoped(globalApp.ensureRoot);
      yield* globalApp.ensureUserLandofile;
      yield* validateGlobalConfiguration(resolved);
      return yield* globalApp.regenerateDist({ services: resolved.composableServices });
    }),
  );
  if (generation._tag === "Failure") causes.push(generation.failure);
  else
    receipt = {
      ...receipt,
      dist: generation.success,
      pending: receipt.pending.filter((entry) => entry.phase !== "generation"),
    };
  const recorded = yield* Effect.result(recordProgress(receipt, targets));
  if (recorded._tag === "Failure") {
    receipt = {
      ...receipt,
      pending: [
        ...receipt.pending,
        pendingWork("evidence", ids, "The reconciliation receipt could not be saved."),
      ],
    };
    return yield* Effect.fail(incomplete(receipt, [...causes, recorded.failure]));
  }
  receipt = { ...receipt, pending: recorded.success.pending };
  if (receipt.pending.length > 0) return yield* Effect.fail(incomplete(receipt, causes));
  return receipt;
});

export const globalEnable = Effect.fn("GlobalPolicy.enable")(
  (options: GlobalPolicyChangeOptions = {}) => changePolicy("enable", options),
  (effect, options: GlobalPolicyChangeOptions = {}) =>
    options.dryRun
      ? withReadOnlyLandofile(effect)
      : withGlobalMutation(withGlobalPolicyChange("enable", effect)),
);

export const globalDisable = Effect.fn("GlobalPolicy.disable")(
  (options: GlobalPolicyChangeOptions = {}) => changePolicy("disable", options),
  (effect, options: GlobalPolicyChangeOptions = {}) =>
    options.dryRun
      ? withReadOnlyLandofile(effect)
      : withGlobalMutation(withGlobalPolicyChange("disable", effect)),
);

export const globalReconcile = Effect.fn("GlobalPolicy.reconcile")(
  (options: Pick<GlobalPolicyChangeOptions, "dryRun" | "allowDisruption"> = {}) =>
    changePolicy("reconcile", options),
  (effect, options: Pick<GlobalPolicyChangeOptions, "dryRun" | "allowDisruption"> = {}) =>
    options.dryRun
      ? withReadOnlyLandofile(effect)
      : withGlobalMutation(withGlobalPolicyChange("reconcile", effect)),
);
