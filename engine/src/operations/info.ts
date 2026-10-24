import { Effect, Schema } from "effect";

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
  type ServiceConnection,
  ServiceInfo,
  type ServicePlan,
  type ServiceState,
} from "@lando/sdk/schema";
import { REDACTED } from "@lando/sdk/secrets";
import {
  type AppPlanner,
  type ConfigService,
  LandofileService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { resolveAgentEnvAudit } from "../config/agent-env-policy.ts";
import { type ResolvedAppTarget, loadUserLandofileAt, planDesiredApp } from "../landofile/app-resolution.ts";
import { observedAppPlan } from "../providers/app-placement.ts";
import { hostProxyPlanExtension } from "../subsystems/host-proxy/plan-extension.ts";
import { resolveAppliedStateTarget } from "./applied-state-target.ts";
import { collectPlanConnections } from "./connection-collector.ts";
import { selectInfoPlan } from "./service-selection.ts";

export type InfoAppError = SdkInfoAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { InfoAppOptions, InfoAppResult, InfoAppService } from "@lando/sdk/app";

type InfoAppServices = AppPlanner | ConfigService | LandofileService | RuntimeProviderRegistry;

export const AppInfoServiceSchema = ServiceInfo;

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
  return {
    app: String(plan.id),
    service: String(service.name),
    api: 4,
    type: service.type,
    provider: String(service.provider),
    primary: service.primary,
    status,
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
): Effect.fn.Return<InfoAppResult, InfoAppError, RuntimeProviderRegistry> {
  const registry = yield* RuntimeProviderRegistry;
  const provider = yield* registry.select(plan);
  const serviceLogSources = provider.capabilities.serviceLogSources === true;
  const rows = yield* collectPlanConnections(plan, undefined, completionPlan);
  const services = rows.map((row) => {
    const service = Object.values(plan.services).find((service) => String(service.name) === row.name);
    if (service === undefined) throw new TypeError(`Missing service plan for ${row.name}`);
    return toServiceInfo(plan, service, row.state, row.connections, serviceLogSources);
  });

  const hostProxy = hostProxyPlanExtension(plan);
  return { app: plan.name, services, ...(hostProxy === undefined ? {} : { hostProxy }) };
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
  const result = yield* infoForPlan(selectedPlan, observedPlan);
  if (options?.deep !== true) return result;
  const agentEnv = yield* resolveAgentEnvAudit(landofile?.document.agentEnv, process.env);
  return { ...result, agentEnv };
});
