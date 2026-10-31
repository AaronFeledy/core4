import { Effect, Result, Schema } from "effect";

import { ToolingExecError } from "@lando/sdk/errors";
import { AppId, ServiceConnection, ServiceState } from "@lando/sdk/schema";
import { FileSystem, GlobalAppService, RuntimeProviderRegistry } from "@lando/sdk/services";

import { resolveGlobalPlacement } from "../global-app/placement.ts";
import { GlobalReconciliationPending, readGlobalReconciliation } from "../global-app/reconciliation.ts";
import { GlobalContributionStateSchema, readGlobalResolution } from "../global-app/resolution.ts";
import { hostProviderId } from "../providers/host-provider.ts";
import { taggedErrorRemediation } from "../providers/managed.ts";
import { withReadOnlyLandofile } from "../services/landofile-live.ts";
import { canonicalMissingAppRoot } from "./app-mutation-lock.ts";
import { type ObservedService, collectObservedConnections, observeService } from "./connection-collector.ts";
import { readGlobalLandofile } from "./global-plan.ts";

export interface GlobalStatusOptions {
  readonly services?: ReadonlyArray<string>;
  readonly format?: "json" | "table";
}

export const GlobalStatusServiceSchema = Schema.Struct({
  app: Schema.String,
  service: Schema.String,
  api: Schema.Literal(4),
  type: Schema.String,
  provider: Schema.String,
  primary: Schema.Boolean,
  status: ServiceState,
  connections: Schema.Array(ServiceConnection),
  desired: Schema.Literals(["enabled", "disabled", "blocked", "unverified", "unmanaged", "unavailable"]),
  policy: Schema.optionalKey(GlobalContributionStateSchema),
  pending: Schema.Array(GlobalReconciliationPending),
});
export type GlobalStatusService = typeof GlobalStatusServiceSchema.Type;

export const GlobalStatusResultSchema = Schema.Struct({
  app: Schema.String,
  materialized: Schema.Boolean,
  revision: Schema.optionalKey(Schema.Number),
  policyState: Schema.Literals(["available", "unavailable"]),
  runtimeState: Schema.Literals(["available", "unavailable"]),
  services: Schema.Array(GlobalStatusServiceSchema),
  pending: Schema.Array(GlobalReconciliationPending),
  diagnostics: Schema.Array(Schema.String),
});
export type GlobalStatusResult = typeof GlobalStatusResultSchema.Type;

const diagnostic = (summary: string, cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : undefined;
  const remediation = taggedErrorRemediation(cause);
  return [summary, message, remediation].filter(Boolean).join(" ");
};

/** Inspect retained resources even when current policy or the desired Landofile is invalid. */
export const globalStatus = Effect.fn("GlobalApp.status")(function* (options: GlobalStatusOptions = {}) {
  const app = yield* GlobalAppService;
  const paths = yield* app.paths;
  const fileSystem = yield* FileSystem;
  const materialized = yield* fileSystem.exists(paths.distLandofile);
  const root = yield* canonicalMissingAppRoot(paths.root);
  const placement = yield* Effect.result(resolveGlobalPlacement());
  const plan = placement._tag === "Success" ? placement.success.plan : undefined;
  const providerId = plan?.provider ?? (yield* hostProviderId);
  const registry = yield* RuntimeProviderRegistry;
  const selected = yield* Effect.result(registry.select(plan ?? providerId));
  const provider = selected._tag === "Success" ? selected.success : undefined;
  let resolution = yield* Effect.result(
    readGlobalResolution({
      providerId,
      ...(provider === undefined ? {} : { providerCapabilities: provider.capabilities }),
    }),
  );
  const composition =
    resolution._tag === "Success" && materialized
      ? yield* Effect.result(withReadOnlyLandofile(readGlobalLandofile({ resolution: resolution.success })))
      : undefined;
  if (composition?._tag === "Success" && composition.success.materialized) {
    resolution = Result.succeed(composition.success.resolution);
  }
  const receipt = yield* Effect.result(readGlobalReconciliation());
  const pending =
    receipt._tag === "Success"
      ? [...receipt.success.pending]
      : [
          {
            phase: "evidence" as const,
            services: [],
            message: "Pending reconciliation records could not be read.",
          },
        ];
  const diagnostics: string[] = [];
  if (placement._tag === "Failure")
    diagnostics.push(diagnostic("Applied global placement could not be read.", placement.failure));
  if (resolution._tag === "Failure")
    diagnostics.push(
      diagnostic("Saved global policy or contribution metadata could not be resolved.", resolution.failure),
    );
  if (receipt._tag === "Failure")
    diagnostics.push(diagnostic("Pending reconciliation records could not be read.", receipt.failure));
  if (selected._tag === "Failure")
    diagnostics.push(diagnostic("The global provider could not be selected.", selected.failure));
  if (composition?._tag === "Failure")
    diagnostics.push(
      diagnostic(
        "Desired configuration could not be validated; contribution rows show saved policy and plugin defaults.",
        composition.failure,
      ),
    );
  const availability =
    provider === undefined
      ? undefined
      : yield* Effect.result(
          provider.isAvailable.pipe(
            Effect.flatMap((available) =>
              available ? Effect.map(provider.getStatus, (status) => status.running) : Effect.succeed(false),
            ),
          ),
        );
  const online = availability?._tag === "Success" && availability.success;
  const observed =
    provider === undefined || !online
      ? undefined
      : yield* Effect.result(
          provider.list({ app: plan?.id ?? AppId.make("global"), includeUnplanned: true }),
        );
  const owned =
    observed?._tag === "Success"
      ? observed.success.filter(
          (service) =>
            service.app === (plan?.id ?? "global") &&
            service.appRoot === root &&
            service.providerId === providerId,
        )
      : [];
  const uncertain =
    observed?._tag === "Success"
      ? observed.success.filter(
          (service) =>
            service.app === (plan?.id ?? "global") &&
            (service.appRoot === undefined || service.providerId === undefined) &&
            (service.appRoot === undefined || service.appRoot === root) &&
            (service.providerId === undefined || service.providerId === providerId),
        )
      : [];
  if (uncertain.length > 0)
    diagnostics.push(
      "Some global runtime observations have incomplete ownership metadata; their resource state is unknown.",
    );
  if (observed?._tag !== "Success")
    diagnostics.push(
      diagnostic(
        "The global runtime could not be observed; resource state is unknown.",
        observed?._tag === "Failure"
          ? observed.failure
          : availability?._tag === "Failure"
            ? availability.failure
            : undefined,
      ),
    );
  const entries = resolution._tag === "Success" ? resolution.success.entries : [];
  const names = new Set([
    ...entries.map((entry) => entry.id),
    ...Object.values(plan?.services ?? {}).map((service) => String(service.name)),
    ...owned.map((service) => String(service.service)),
    ...uncertain.map((service) => String(service.service)),
    ...pending.flatMap((entry) => entry.services),
  ]);
  const missing = options.services?.find((name) => !names.has(name));
  if (missing !== undefined)
    return yield* Effect.fail(
      new ToolingExecError({
        message: `Unknown global service: ${missing}; available: ${[...names].sort().join(", ") || "none"}.`,
        tool: "meta:global:status",
        remediation: `Select a catalog or observed service: ${[...names].sort().join(", ") || "none"}.`,
      }),
    );
  const selectedNames = new Set(options.services?.length ? options.services : names);
  const observations: ObservedService[] = [];
  if (plan !== undefined) {
    for (const service of Object.values(plan.services)) {
      if (!selectedNames.has(String(service.name))) continue;
      const inspection =
        provider === undefined || !online
          ? undefined
          : yield* Effect.result(provider.inspect({ app: plan.id, service: service.name, plan }));
      if (inspection?._tag === "Success") observations.push(observeService(plan, inspection.success));
    }
  }
  const connections = plan === undefined ? [] : yield* collectObservedConnections(plan, observations);
  const services: GlobalStatusService[] = [...selectedNames].sort().map((name) => {
    const policy = entries.find((entry) => entry.id === name);
    const applied = Object.values(plan?.services ?? {}).find((service) => service.name === name);
    const runtime = owned.find((service) => service.service === name);
    const collected = connections.find((row) => row.name === name);
    const ownershipUnknown = uncertain.some((service) => service.service === name);
    const rawState = runtime?.state ?? runtime?.status;
    const status =
      collected?.state ??
      (Schema.is(ServiceState)(rawState)
        ? rawState
        : observed?._tag === "Success" && !ownershipUnknown
          ? "stopped"
          : "unknown");
    const work = pending.filter((entry) => entry.services.length === 0 || entry.services.includes(name));
    if (ownershipUnknown)
      work.push({
        phase: "evidence",
        services: [name],
        message: "Observed resource ownership is incomplete; absence cannot be verified.",
      });
    if (
      policy?.state === "disabled" &&
      status !== "stopped" &&
      !work.some((entry) => entry.phase === "containers" || entry.phase === "evidence")
    ) {
      work.push({
        phase: status === "unknown" ? "evidence" : "containers",
        services: [name],
        message: "Disabled contribution still has running or unverified resources.",
      });
    }
    return {
      app: "global",
      service: name,
      api: 4,
      type:
        applied?.type ??
        (resolution._tag === "Success" ? resolution.success.services[name]?.type : undefined) ??
        "unknown",
      provider: String(applied?.provider ?? providerId),
      primary: applied?.primary ?? false,
      status,
      connections: collected?.connections ?? [],
      desired: policy?.state ?? (resolution._tag === "Success" ? "unmanaged" : "unavailable"),
      ...(policy === undefined ? {} : { policy }),
      pending: work,
    };
  });
  const allPending = [...pending];
  for (const service of services) {
    for (const work of service.pending) {
      if (
        !allPending.some(
          (entry) =>
            entry.phase === work.phase &&
            entry.message === work.message &&
            entry.services.join("\0") === work.services.join("\0"),
        )
      )
        allPending.push(work);
    }
  }
  return {
    app: "global",
    materialized,
    ...(resolution._tag === "Success" ? { revision: resolution.success.policy.revision } : {}),
    policyState: resolution._tag === "Success" ? ("available" as const) : ("unavailable" as const),
    runtimeState: observed?._tag === "Success" ? ("available" as const) : ("unavailable" as const),
    services,
    pending: allPending,
    diagnostics,
  };
});
