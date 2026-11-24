import type {
  InfoAppOptions,
  InfoAppResult,
  InfoAppService,
  InfoAppError as SdkInfoAppError,
} from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type LoadScopedLandofile,
  type ServiceCreds,
  ServiceInfoConsistent,
  type ServicePlan,
  landoServiceNetworkAttachments,
  serviceAppMount,
} from "@lando/sdk/schema";
import { REDACTED, isPublicDefaultCredential } from "@lando/sdk/secrets";
import {
  type AppPlanner,
  type ConfigService,
  LandofileService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { Effect, Result, Schema } from "effect";

import { resolveAgentEnvAudit } from "../config/agent-env-policy.ts";
import { routerEnabled } from "../config/router-config.ts";
import { type ResolvedAppTarget, loadUserLandofileAt, planDesiredApp } from "../landofile/app-resolution.ts";
import { observedAppPlan } from "../providers/app-placement.ts";
import { hostProxyPlanExtension } from "../subsystems/host-proxy/plan-extension.ts";
import { hostProxyEligibleServices } from "../subsystems/host-proxy/worker-service-plan.ts";
import { collectObservedConnections, collectPlanObservations } from "./connection-collector.ts";
import { isSameInfoAppliedStateFailure, observeInfoAppliedState } from "./info-applied-state.ts";
import { projectFileSyncInfo } from "./info-file-sync.ts";
import { infoLogSources } from "./info-log-sources.ts";
import { projectServiceObservation } from "./info-probes.ts";
import { projectServiceMounts } from "./info-storage.ts";
import { resolveInfoTarget } from "./info-target.ts";
import { plannedServiceArtifact } from "./planned-service-artifact.ts";
import { primaryRouteConnectionUrl } from "./route-connections.ts";
import { selectInfoPlan } from "./service-selection.ts";

export type InfoAppError = SdkInfoAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { InfoAppOptions, InfoAppResult, InfoAppService } from "@lando/sdk/app";

type InfoAppServices = AppPlanner | ConfigService | LandofileService | RuntimeProviderRegistry;

const CertsProvenance = Schema.Literals(["none", "custom"]);

// A published development default is public as a literal; every deferred
// descriptor and every other value stays redacted without touching a store.
const displayedCredential = (value: ServiceCreds["password"]): string =>
  typeof value === "string" && isPublicDefaultCredential(value) ? value : REDACTED;

const displayedCreds = (creds: ServiceCreds): InfoAppService["creds"] => ({
  user: creds.user,
  password: displayedCredential(creds.password),
  database: creds.database,
  ...(creds.rootPassword === undefined ? {} : { rootPassword: displayedCredential(creds.rootPassword) }),
});

const credsFromConnection = (connection: ServicePlan["connection"]): InfoAppService["creds"] =>
  connection === undefined ? undefined : displayedCreds(connection.creds);

const credsFromService = (service: ServicePlan): InfoAppService["creds"] => {
  if (service.sqlite !== undefined) return { engine: "sqlite", path: service.sqlite.path };
  if (service.connection !== undefined) return credsFromConnection(service.connection);
  return service.nonSqlCreds === undefined ? undefined : displayedCreds(service.nonSqlCreds);
};

const serviceInfoMetadata = (
  plan: AppPlan,
  service: ServicePlan,
  capabilities: RuntimeProviderShape["capabilities"],
): Omit<InfoAppService, "status" | "health" | "readiness" | "connections"> => {
  const logSources = infoLogSources(service, capabilities);
  const creds = credsFromService(service);
  const artifact = plannedServiceArtifact(service.artifact);
  const hostnames = Array.from(
    new Set(landoServiceNetworkAttachments(plan, service).flatMap((attachment) => attachment.aliases)),
  );
  const certsProvenance = service.extensions["@lando/core/certs"];
  const certs =
    service.certs !== undefined
      ? { state: "generated" as const }
      : Schema.is(CertsProvenance)(certsProvenance)
        ? { state: certsProvenance }
        : undefined;
  return {
    app: String(plan.id),
    service: String(service.name),
    api: 4,
    type: service.type,
    provider: String(service.provider),
    primary: service.primary,
    ...(artifact === undefined ? {} : { artifact }),
    ...(service.user === undefined ? {} : { user: service.user }),
    ...(service.projectUser === undefined ? {} : { projectUser: service.projectUser }),
    ...(service.projectUserExplanation === undefined
      ? {}
      : { projectUserExplanation: service.projectUserExplanation }),
    ...(service.workingDirectory === undefined ? {} : { workingDirectory: service.workingDirectory }),
    hostnames,
    ...(certs === undefined ? {} : { certs }),
    ...(service.home === undefined ? {} : { home: service.home }),
    ...(service.listenerAuthority === undefined ? {} : { listenerAuthority: service.listenerAuthority }),
    ...(logSources.length === 0 ? {} : { logSources }),
    ...(creds === undefined ? {} : { creds }),
  };
};

const unknownFileSyncPolicy = {
  mode: "unknown" as const,
  reason: "unknown" as const,
  services: [] as const,
};

// Requires only RuntimeProviderRegistry (no LandofileService/AppPlanner) so
// out-of-band plan resolvers (global-app commands) reuse this without pulling
// user-Landofile resolution into their bootstrap layer.
export const infoForPlan = Effect.fn("AppOperation.infoForPlan")(function* (
  plan: AppPlan,
  completionPlan: AppPlan = plan,
  options: {
    readonly plannedPolicy?: AppPlan | null;
    readonly appName?: string;
    readonly desiredOnly?: ReadonlySet<string>;
    readonly kind?: "user" | "global";
  } = {},
): Effect.fn.Return<InfoAppResult, InfoAppError, RuntimeProviderRegistry> {
  const registry = yield* RuntimeProviderRegistry;
  const { applied, appliedStateIssue } = yield* observeInfoAppliedState(
    completionPlan,
    options.kind ?? "user",
  );
  const provider = yield* registry.select(plan);
  const observations = yield* collectPlanObservations(
    plan,
    completionPlan,
    appliedStateIssue === undefined
      ? provider
      : {
          ...provider,
          inspect: (target) =>
            provider.inspect(target).pipe(
              Effect.catchIf(
                (failure) => isSameInfoAppliedStateFailure(failure, appliedStateIssue, plan.provider),
                () =>
                  Effect.succeed({
                    app: target.app,
                    service: target.service,
                    providerId: plan.provider,
                    status: "unknown" as const,
                    publications: { status: "unknown" as const },
                  }),
              ),
            ),
        },
  );
  const rows = yield* collectObservedConnections(plan, observations);
  // The service URL follows the routes Lando last applied, as `{{ services.<name>.url }}` does; an
  // unreadable applied state leaves that unknown, and a disabled router publishes no URL.
  const urlPlan = appliedStateIssue === undefined ? (applied ?? plan) : undefined;
  const urlRoutes = urlPlan !== undefined && routerEnabled(urlPlan) ? urlPlan.routes : [];
  const services = rows.map((row) => {
    const service = Object.values(plan.services).find((service) => String(service.name) === row.name);
    if (service === undefined) throw new TypeError(`Missing service plan for ${row.name}`);
    const observed = observations.find((candidate) => candidate.name === row.name);
    if (observed === undefined) throw new TypeError(`Missing observation for ${row.name}`);
    const desiredOnly = options.desiredOnly?.has(row.name) === true;
    const mounts = desiredOnly ? undefined : projectServiceMounts(plan, service, observed.runtime);
    const appMount = serviceAppMount(service);
    const url = desiredOnly ? undefined : primaryRouteConnectionUrl(urlRoutes, row.name, row.connections);
    return ServiceInfoConsistent.make({
      ...serviceInfoMetadata(plan, service, provider.capabilities),
      ...projectServiceObservation(service, observed),
      ...(desiredOnly && observed.state === "stopped" && observed.runtime.status !== "absent"
        ? { status: "unknown" as const }
        : {}),
      connections: desiredOnly ? [] : row.connections,
      ...(url === undefined ? {} : { url }),
      ...(mounts === undefined ? {} : { mounts }),
      ...(appMount === undefined ? {} : { appMount }),
    });
  });

  const hostProxy =
    hostProxyEligibleServices(plan).length === 0
      ? undefined
      : (hostProxyPlanExtension(plan) ?? { runLando: { availability: "available" as const } });
  // selectInfoPlan returns the original plan only for an unscoped view.
  const selectedServices = plan === completionPlan ? undefined : Object.keys(plan.services);
  const appName = options.appName ?? plan.name;
  const dataName = plan.identity?.dataName ?? plan.name;
  const plannedPolicy = options.plannedPolicy === undefined ? completionPlan : options.plannedPolicy;
  const fileSync =
    appliedStateIssue !== undefined
      ? {
          ...projectFileSyncInfo(plannedPolicy ?? undefined, undefined, selectedServices),
          applied: unknownFileSyncPolicy,
          pendingChange: false,
        }
      : projectFileSyncInfo(plannedPolicy ?? undefined, applied, selectedServices);
  return {
    app: appName,
    ...(dataName === appName ? {} : { dataName }),
    services,
    fileSync,
    ...(appliedStateIssue === undefined ? {} : { appliedStateIssue }),
    ...(hostProxy === undefined ? {} : { hostProxy }),
  };
});

export const infoApp = Effect.fn("AppOperation.info")(function* (
  options?: InfoAppOptions,
  target?: ResolvedAppTarget,
): Effect.fn.Return<InfoAppResult, InfoAppError, InfoAppServices> {
  const landofileService = yield* LandofileService;

  let plan: AppPlan;
  let landofile: LoadScopedLandofile | undefined;
  const observedTarget = target ?? (yield* resolveInfoTarget);
  if (observedTarget !== undefined) {
    plan = observedTarget.plan;
    if (options?.deep === true) {
      landofile =
        observedTarget.landofile ?? (yield* loadUserLandofileAt(landofileService, observedTarget.root));
    } else if (target === undefined) {
      // An applied plan carries its recorded name; the Landofile names the app now, when it loads.
      landofile = yield* loadUserLandofileAt(landofileService, observedTarget.root).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
    }
  } else {
    ({ plan, landofile } = yield* planDesiredApp);
  }

  const observedPlan = yield* observedAppPlan(plan, true);
  let desired: AppPlan | null = target?.plan ?? plan;
  if (observedTarget !== undefined && target === undefined) {
    const planned = yield* Effect.result(planDesiredApp);
    desired = Result.match(planned, { onFailure: () => null, onSuccess: ({ plan }) => plan });
  }
  const desiredOnly = new Set(
    Object.keys(desired?.services ?? {}).filter((name) => !Object.hasOwn(observedPlan.services, name)),
  );
  const combined =
    desiredOnly.size === 0
      ? observedPlan
      : {
          ...observedPlan,
          services: { ...desired?.services, ...observedPlan.services },
        };
  const selectedPlan = yield* selectInfoPlan(combined, options?.services);
  const result = yield* infoForPlan(selectedPlan, combined, {
    plannedPolicy: desired,
    appName: landofile?.document.name ?? plan.name,
    desiredOnly,
  });
  if (options?.deep !== true) return result;
  const agentEnv = yield* resolveAgentEnvAudit(landofile?.document.agentEnv, process.env);
  return { ...result, agentEnv };
});
