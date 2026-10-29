import { Effect, Result, Schema } from "effect";

import type {
  InfoAppOptions,
  InfoAppResult,
  InfoAppService,
  InfoAppError as SdkInfoAppError,
} from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
import {
  type AppPlan,
  FileSyncInfo,
  type LoadScopedLandofile,
  type ServiceConnection,
  ServiceInfo,
  type ServicePlan,
  type ServiceState,
  landoServiceNetworkAttachments,
  serviceAppMount,
} from "@lando/sdk/schema";
import { REDACTED } from "@lando/sdk/secrets";
import {
  type AppPlanner,
  type ConfigService,
  LandofileService,
  RuntimeProviderRegistry,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";

import { resolveAgentEnvAudit } from "../config/agent-env-policy.ts";
import { type ResolvedAppTarget, loadUserLandofileAt, planDesiredApp } from "../landofile/app-resolution.ts";
import { observedAppPlan } from "../providers/app-placement.ts";
import { hostProxyPlanExtension } from "../subsystems/host-proxy/plan-extension.ts";
import { resolveAppliedStateTarget } from "./applied-state-target.ts";
import { collectObservedConnections, collectPlanObservations } from "./connection-collector.ts";
import { projectFileSyncInfo } from "./info-file-sync.ts";
import { projectServiceMounts } from "./info-storage.ts";
import { selectInfoPlan } from "./service-selection.ts";

export type InfoAppError = SdkInfoAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { InfoAppOptions, InfoAppResult, InfoAppService } from "@lando/sdk/app";

type InfoAppServices = AppPlanner | ConfigService | LandofileService | RuntimeProviderRegistry;

export const AppInfoServiceSchema = ServiceInfo;

const CertsProvenance = Schema.Literals(["none", "custom"]);

export const AppInfoAgentEnvSchema = Schema.Struct({
  enabled: Schema.Boolean,
  forwarded: Schema.Array(Schema.String),
});

const AppInfoHostProxySchema = Schema.Struct({
  runLando: Schema.Struct({
    availability: Schema.Literals(["available", "unavailable"]),
    reason: Schema.optionalKey(Schema.String),
  }),
});

export const AppInfoResultSchema = Schema.Struct({
  app: Schema.String,
  services: Schema.Array(AppInfoServiceSchema),
  agentEnv: Schema.optionalKey(AppInfoAgentEnvSchema),
  hostProxy: Schema.optionalKey(AppInfoHostProxySchema),
  fileSync: Schema.optionalKey(FileSyncInfo),
});

const credsFromConnection = (connection: ServicePlan["connection"]): InfoAppService["creds"] => {
  if (connection === undefined) return undefined;
  const { user, database, rootPassword } = connection.creds;
  return {
    user,
    password: REDACTED,
    database,
    ...(rootPassword === undefined ? {} : { rootPassword: REDACTED }),
  };
};

const toServiceInfo = (
  plan: AppPlan,
  service: ServicePlan,
  status: ServiceState,
  connections: readonly ServiceConnection[],
  serviceLogSources: boolean,
  runtimeHealth: ServiceRuntimeInfo["health"],
): InfoAppService => {
  const logSources = (service.logSources ?? []).map((source) => {
    const base = { id: String(source.id), path: String(source.path), strategy: source.strategy };
    if (source.strategy === "redirect") {
      return { ...base, availability: "redirected-to-console" as const };
    }
    if (serviceLogSources) return { ...base, availability: "available" as const };
    return {
      ...base,
      availability: "unavailable" as const,
      reason:
        "This provider cannot follow log files. Set `strategy: redirect` on this source to view it with `lando logs`.",
    };
  });
  const creds = credsFromConnection(service.connection);
  const artifact =
    service.artifact === undefined
      ? undefined
      : service.artifact.kind === "ref"
        ? {
            kind: "ref" as const,
            ref: service.artifact.ref,
            ...(service.artifact.digest === undefined ? {} : { digest: service.artifact.digest }),
          }
        : {
            kind: "build" as const,
            ...(service.artifact.contentHash === undefined
              ? {}
              : { contentHash: service.artifact.contentHash }),
          };
  const hostnames = Array.from(
    new Set(landoServiceNetworkAttachments(plan, service).flatMap((attachment) => attachment.aliases)),
  );
  const healthcheck = service.healthcheck;
  const certsProvenance = service.extensions["@lando/core/certs"];
  const certs =
    service.certs !== undefined
      ? { state: "generated" as const }
      : Schema.is(CertsProvenance)(certsProvenance)
        ? { state: certsProvenance }
        : undefined;
  const health =
    healthcheck === undefined && runtimeHealth === undefined
      ? undefined
      : {
          state: runtimeHealth ?? ("unknown" as const),
          ...(healthcheck === undefined
            ? {}
            : {
                check: {
                  kind: healthcheck.kind,
                  intervalSeconds: healthcheck.intervalSeconds,
                  timeoutSeconds: healthcheck.timeoutSeconds,
                  retries: healthcheck.retries,
                  ...(healthcheck.startPeriodSeconds === undefined
                    ? {}
                    : { startPeriodSeconds: healthcheck.startPeriodSeconds }),
                },
              }),
        };
  return {
    app: String(plan.id),
    service: String(service.name),
    api: 4,
    type: service.type,
    provider: String(service.provider),
    primary: service.primary,
    status,
    ...(artifact === undefined ? {} : { artifact }),
    ...(service.user === undefined ? {} : { user: service.user }),
    ...(service.workingDirectory === undefined ? {} : { workingDirectory: service.workingDirectory }),
    hostnames,
    ...(certs === undefined ? {} : { certs }),
    ...(health === undefined ? {} : { health }),
    ...(service.home === undefined ? {} : { home: service.home }),
    connections,
    ...(logSources.length === 0 ? {} : { logSources }),
    ...(creds === undefined ? {} : { creds }),
  };
};

// Requires only RuntimeProviderRegistry (no LandofileService/AppPlanner) so
// out-of-band plan resolvers (global-app commands) reuse this without pulling
// user-Landofile resolution into their bootstrap layer.
export const infoForPlan = Effect.fn("AppOperation.infoForPlan")(function* (
  plan: AppPlan,
  completionPlan: AppPlan = plan,
  plannedPolicy: AppPlan | null = completionPlan,
): Effect.fn.Return<InfoAppResult, InfoAppError, RuntimeProviderRegistry> {
  const registry = yield* RuntimeProviderRegistry;
  const provider = yield* registry.select(plan);
  const serviceLogSources = provider.capabilities.serviceLogSources === true;
  const observations = yield* collectPlanObservations(plan, completionPlan, provider);
  const rows = yield* collectObservedConnections(plan, observations);
  const services = rows.map((row) => {
    const service = Object.values(plan.services).find((service) => String(service.name) === row.name);
    if (service === undefined) throw new TypeError(`Missing service plan for ${row.name}`);
    const runtime = observations.find((observed) => observed.name === row.name)?.runtime;
    const mounts = projectServiceMounts(plan, service, runtime);
    const appMount = serviceAppMount(service);
    return {
      ...toServiceInfo(plan, service, row.state, row.connections, serviceLogSources, runtime?.health),
      ...(mounts === undefined ? {} : { mounts }),
      ...(appMount === undefined ? {} : { appMount }),
    };
  });

  const hostProxy = hostProxyPlanExtension(plan);
  const applied = yield* registry.resolveAppliedPlan(completionPlan.identity?.appRoot ?? completionPlan.root);
  // selectInfoPlan returns the original plan only for an unscoped view.
  const selectedServices = plan === completionPlan ? undefined : Object.keys(plan.services);
  return {
    app: plan.name,
    services,
    fileSync: projectFileSyncInfo(plannedPolicy ?? undefined, applied, selectedServices),
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
  const observedTarget = target ?? (yield* resolveAppliedStateTarget);
  if (observedTarget !== undefined) {
    plan = observedTarget.plan;
    if (options?.deep === true) {
      landofile =
        observedTarget.landofile ?? (yield* loadUserLandofileAt(landofileService, observedTarget.root));
    }
  } else {
    ({ plan, landofile } = yield* planDesiredApp);
  }

  const observedPlan = yield* observedAppPlan(plan);
  const selectedPlan = yield* selectInfoPlan(observedPlan, options?.services);
  let desired: AppPlan | null = target?.plan ?? plan;
  if (observedTarget !== undefined && target === undefined) {
    const planned = yield* Effect.result(planDesiredApp);
    desired = Result.match(planned, { onFailure: () => null, onSuccess: ({ plan }) => plan });
  }
  const result = yield* infoForPlan(selectedPlan, observedPlan, desired);
  if (options?.deep !== true) return result;
  const agentEnv = yield* resolveAgentEnvAudit(landofile?.document.agentEnv, process.env);
  return { ...result, agentEnv };
});
