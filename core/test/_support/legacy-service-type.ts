// Test helper assembling a `ServiceType` whose plan body still lives under the
import { Effect, Schema } from "effect";

import type { ServiceConfig, ServicePlan } from "@lando/sdk/schema";
import type {
  ServiceFeatureDefinition,
  ServiceType,
  ServiceTypeInput,
  ServiceTypeResolution,
} from "@lando/sdk/services";

interface ServicePlanInput {
  readonly name: string;
  readonly service: ServiceConfig;
  readonly appRoot: string;
  readonly appName?: string;
  readonly provider?: ServicePlan["provider"];
  readonly primary?: boolean;
  readonly metadata: { readonly resolvedAt: string; readonly source: string; readonly runtime: 4 };
}

export interface MakeLegacyServiceTypeFakeOptions {
  readonly id: string;
  readonly name?: string;
  readonly base?: "l337" | "lando";
  readonly toServicePlan: (input: ServicePlanInput) => ServicePlan;
}

export interface ServiceTypeFake extends ServiceType {
  readonly testFeature: ServiceFeatureDefinition;
}

export const makeLegacyServiceTypeFake = (options: MakeLegacyServiceTypeFakeOptions): ServiceTypeFake => {
  const base = options.base ?? "l337";
  const featureId = `${options.id}.test-plan`;
  const testFeature: ServiceFeatureDefinition = {
    id: featureId,
    priority: 100,
    apply: (ctx) =>
      Effect.sync(() => {
        const plan = options.toServicePlan({
          name: ctx.serviceName,
          service: ctx.normalizedConfig,
          appRoot: ctx.appRoot,
          primary: ctx.primary,
          ...(ctx.appName === undefined ? {} : { appName: ctx.appName }),
          metadata: {
            resolvedAt: "2026-05-18T08:00:00Z",
            source: "@lando/core/test/service-type-fake",
            runtime: 4,
          },
        });

        for (const [key, value] of Object.entries(plan.environment)) ctx.addEnv(key, value);
        for (const mount of plan.mounts) ctx.addMount(mount);
        if (plan.appMount !== undefined) ctx.setAppMount(plan.appMount);
        for (const storage of plan.storage) ctx.addStorage(storage);
        for (const endpoint of plan.endpoints) ctx.addEndpoint(endpoint);
        for (const dependency of plan.dependsOn) ctx.addDependency(dependency);
        for (const alias of plan.hostAliases) ctx.addHostAlias(alias);
        if (plan.healthcheck !== undefined) ctx.setHealthcheck(plan.healthcheck);
        if (plan.certs !== undefined) ctx.setCerts(plan.certs);
        if (plan.entrypoint !== undefined) ctx.setEntrypoint(plan.entrypoint);
        if (plan.command !== undefined) ctx.setCommand(plan.command);
        if (plan.artifact !== undefined) ctx.setArtifact(plan.artifact);
        if (plan.user !== undefined) ctx.setUser(plan.user);
        if (plan.workingDirectory !== undefined) ctx.setWorkingDirectory(plan.workingDirectory);
        for (const [key, value] of Object.entries(plan.extensions)) ctx.addExtension(key, value);
      }),
  };

  return {
    id: options.id,
    name: options.name ?? options.id,
    base,
    schema: Schema.Unknown,
    resolve: (input: ServiceTypeInput): Effect.Effect<ServiceTypeResolution, never> =>
      Effect.succeed({ base, normalizedConfig: input.service, features: [{ id: featureId }] }),
    testFeature,
  };
};
