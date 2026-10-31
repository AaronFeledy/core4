import { Effect, Schema } from "effect";

import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { GlobalAppError } from "@lando/sdk/errors";
import { type AppPlan, type ServiceConfig, ServicePlan } from "@lando/sdk/schema";
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
import { prepareGlobalConfiguration } from "../global-app/preparation.ts";
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
} from "../global-app/resolution.ts";
import { withReadOnlyLandofile } from "../services/landofile-live.ts";
import { readGlobalConsumerReservations } from "./global-consumer-lease.ts";
import {
  GlobalConsumerProtectionError,
  GlobalConsumerSchema,
  readGlobalConsumerImpact,
} from "./global-consumers.ts";
import { GlobalDistResultSchema } from "./global-install.ts";
import { dependencyError } from "./global-policy-cleanup-evidence.ts";
import { cleanupDisabledGlobalResources } from "./global-policy-cleanup.ts";

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

const serviceFingerprint = (service: typeof ServicePlan.Type): string =>
  sha256Hex(canonicalJson({ ...Schema.encodeSync(ServicePlan)(service), routes: undefined }));

const recordProgress = (
  receipt: GlobalPolicyChangeResult,
  targets: ReadonlyArray<GlobalReconciliationTarget>,
  supersede?: ReadonlyArray<string>,
) =>
  recordGlobalReconciliation(
    {
      revision: receipt.revision,
      targets: receipt.operation === "enable" ? [] : targets,
      operation: receipt.operation,
      contributions: receipt.contributions,
      servicesRemoved: receipt.servicesRemoved,
      pending: receipt.pending,
    },
    supersede === undefined ? {} : { supersede },
  );

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
  const runtime = yield* Effect.result(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      const providerId = yield* globalCreateProviderId();
      return { providerId, provider: yield* registry.select(providerId) };
    }),
  );
  const preparation = yield* prepareGlobalConfiguration(
    runtime._tag === "Success"
      ? {
          providerId: runtime.success.providerId,
          providerCapabilities: runtime.success.provider.capabilities,
        }
      : {},
  );
  const current = yield* preparation.resolve();
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
  const candidate = yield* preparation.resolve(prepared.policy);
  // Read applied metadata without constructing the runtime before calculating impact.
  const placement = yield* Effect.result(resolveGlobalPlacement());
  const applied = placement._tag === "Success" ? placement.success.plan : undefined;
  const composition = operation === "enable" ? undefined : yield* Effect.result(preparation.compile(current));
  const authored =
    composition?._tag === "Success" ? composition.success.landofile.document.services : undefined;
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
  const supersededIds =
    operation === "enable"
      ? prepared.selections
          .filter((entry) => {
            const owner = prepared.policy.plugins[entry.plugin];
            const preference = owner?.contributions[entry.id];
            if (
              preference === undefined ||
              !(preference.enabled ?? owner?.enabled ?? preference.defaultEnabled)
            )
              return false;
            const targets =
              previousReceiptResult._tag === "Success"
                ? (previousReceiptResult.success.targets ?? []).filter((target) => target.id === entry.id)
                : [];
            if (targets.length > 0) return targets.every((target) => target.plugin === entry.plugin);
            const owners = Object.entries(prepared.policy.plugins).filter(([, policy]) =>
              Object.hasOwn(policy.contributions, entry.id),
            );
            return (
              owners.length === 1 &&
              owners[0]?.[0] === entry.plugin &&
              !current.contributions.some(
                (contribution) =>
                  contribution.contribution.id === entry.id && contribution.plugin !== entry.plugin,
              )
            );
          })
          .map((entry) => entry.id)
      : undefined;
  const ids =
    operation === "reconcile"
      ? [
          ...new Set([
            ...candidate.entries.filter((entry) => !entry.enabled).map((entry) => entry.id),
            ...retiredTargets.map((target) => target.id),
          ]),
        ].sort()
      : prepared.ids;
  const contributionIds = [...new Set([...ids, ...(supersededIds ?? [])])].sort();
  const supersessionUncertainties =
    operation === "enable"
      ? prepared.selections.flatMap((entry) => {
          if (
            supersededIds?.includes(entry.id) ||
            !previousReceipt.pending.some(
              (pending) => pending.phase !== "generation" && pending.services.includes(entry.id),
            )
          )
            return [];
          const owners = Object.entries(prepared.policy.plugins)
            .filter(([, policy]) => Object.hasOwn(policy.contributions, entry.id))
            .map(([plugin]) => plugin);
          const currentOwners = current.contributions
            .filter((contribution) => contribution.contribution.id === entry.id)
            .map((contribution) => contribution.plugin);
          return [
            `Pending cleanup for ${entry.id} cannot be attributed to selected owner ${entry.plugin}. Policy owners: ${owners.join(", ")}; current owners: ${currentOwners.join(", ") || "none"}. Enabling intent does not establish this ownership, so cleanup remains pending.`,
          ];
        })
      : [];
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
            return yield* preparation.compile(candidate);
          }),
        )
      : undefined;
  const effectiveCandidate = projectEffectiveGlobalResolution(
    candidate,
    validation?._tag === "Success"
      ? (validation.success.landofile.document.services ?? {})
      : (authored ?? candidate.composableServices),
    validation?._tag === "Success"
      ? validation.success.landofile.pendingSites
      : composition?._tag === "Success"
        ? composition.success.landofile.pendingSites
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
    contributions: contributionIds,
    plugins: prepared.plugins,
    dependencyBlockers: blockers,
    consumers: consumerImpact.consumers,
    allowDisruption: options.allowDisruption === true,
    routes: (applied?.routes ?? [])
      .filter((route) => selected.has(String(route.service)))
      .map((route) => ({ service: String(route.service), hostname: route.hostname })),
    volumes: "retained",
    uncertainties: [
      ...supersessionUncertainties,
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
      contributions: contributionIds,
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
      if (validation?._tag === "Success") yield* validation.success.verify;
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
  let receipt: GlobalPolicyChangeResult = {
    dryRun: false,
    impact,
    operation,
    revision: policy.revision,
    policySaved: true,
    contributions: contributionIds,
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
      pendingWork("generation", contributionIds, "Generated configuration has not yet been reconciled."),
    ],
  };
  const causes: unknown[] = supersessionUncertainties.map(
    (message) =>
      new GlobalAppError({
        operation: "reconciliation",
        message,
        remediation: "Restore matching owned cleanup evidence or explicitly stop the whole global app.",
      }),
  );
  const marked = yield* Effect.result(recordProgress(receipt, targets, supersededIds));
  if (marked._tag === "Failure") return yield* Effect.fail(incomplete(receipt, [marked.failure]));

  if (operation !== "enable" && ids.length > 0) {
    const cleanup = yield* cleanupDisabledGlobalResources({
      receipt,
      candidate,
      targets,
      priorRouteIds,
      ...(previousReceiptResult._tag === "Success" &&
      previousReceiptResult.success.routesClearedRevision !== undefined
        ? { routesClearedRevision: previousReceiptResult.success.routesClearedRevision }
        : {}),
      dependencyBlockers: (plan) => dependencyBlockers(candidate, selected, plan, authored),
    });
    receipt = cleanup.receipt;
    causes.push(...cleanup.causes);
  }

  // Configuration errors in another contribution cannot prevent selected container cleanup.
  const generation = yield* Effect.result(
    Effect.gen(function* () {
      const resolved = candidate;
      yield* assertGlobalResolution(resolved, undefined, { directOnly: true });
      const globalApp = yield* GlobalAppService;
      const generated =
        validation?._tag === "Success" ? validation.success : yield* preparation.compile(resolved);
      yield* generated.verify;
      const dist = yield* globalApp.regenerateDist({
        services: resolved.composableServices,
        content: generated.content,
      });
      yield* globalApp.ensureUserLandofile;
      return dist;
    }),
  );
  if (generation._tag === "Failure") causes.push(generation.failure);
  else
    receipt = {
      ...receipt,
      dist: generation.success,
      pending: receipt.pending.filter((entry) => entry.phase !== "generation"),
    };
  const recorded = yield* Effect.result(recordProgress(receipt, targets, supersededIds));
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
