import { type Context, Effect, Either, Layer, ParseResult, Schema } from "effect";

import { CapabilityError, LandofileValidationError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  AppPlan,
  type LandofileShape,
  type ProviderCapabilities,
  ProviderId,
  type ServiceConfig,
  ServicePlan,
} from "@lando/sdk/schema";
import { AppPlanner, PluginRegistry } from "@lando/sdk/services";

export { AppPlanner } from "@lando/sdk/services";

const validationIssues = (cause: unknown): ReadonlyArray<string> => {
  if (ParseResult.isParseError(cause)) {
    return ParseResult.ArrayFormatter.formatErrorSync(cause).map((issue) =>
      issue.path.length === 0 ? issue.message : issue.path.join("."),
    );
  }
  return [cause instanceof Error ? cause.message : "Invalid app plan."];
};

const serviceTypeFor = (name: string, service: ServiceConfig): string => {
  if (service.type !== undefined) return service.type;
  if (service.image?.startsWith("node:22")) return "node:22";
  if (service.image?.startsWith("node:")) return "node:lts";
  if (service.image?.startsWith("postgres")) return "postgres";
  if (service.image?.startsWith("php:8.2")) return "php:8.2";
  if (service.image?.startsWith("php:8.3")) return "php:8.3";
  return name;
};

const unsupportedServiceType = (
  appRoot: string,
  serviceName: string,
  serviceType: string,
  registeredTypeIds: ReadonlyArray<string>,
) => {
  const colonIdx = serviceType.indexOf(":");
  const prefix = colonIdx > 0 ? serviceType.slice(0, colonIdx + 1) : null;
  const familyMatches = prefix === null ? [] : registeredTypeIds.filter((id) => id.startsWith(prefix)).sort();
  let remediation = "";
  if (familyMatches.length > 0) {
    remediation = ` Supported alternatives: ${familyMatches.join(", ")}.`;
  } else if (registeredTypeIds.length > 0) {
    remediation = ` Registered service types: ${[...registeredTypeIds].sort().join(", ")}.`;
  }
  return new LandofileValidationError({
    message: `Unsupported service type ${serviceType} for service ${serviceName}.${remediation}`,
    file: `${appRoot}/.lando.yml`,
    issues: [`services.${serviceName}.type`],
  });
};

const missingCapability = (
  providerId: ProviderId,
  serviceName: string,
  feature: string,
  capability: keyof ProviderCapabilities,
  remediation: string,
) =>
  new CapabilityError({
    message: `Service ${serviceName} requires provider capability ${String(capability)} for ${feature}.`,
    service: serviceName,
    feature,
    capability: String(capability),
    providerId: String(providerId),
    remediation,
  });

const serviceBindRemediation = (serviceName: string) =>
  `Choose a provider with bind mount support or remove bind mounts from service ${serviceName}.`;

const bindRealization = (providerCapabilities: ProviderCapabilities) =>
  providerCapabilities.bindMountPerformance === "slow" ? "accelerated" : "passthrough";

const decodeAppPlan = (appRoot: string, plan: unknown): Effect.Effect<AppPlan, LandofileValidationError> => {
  const decoded = Schema.decodeUnknownEither(AppPlan)(plan);
  if (Either.isRight(decoded)) return Effect.succeed(decoded.right);
  const issues = validationIssues(decoded.left);
  return Effect.fail(
    new LandofileValidationError({
      message: `Planned AppPlan is invalid: ${issues.join(", ")}.`,
      file: `${appRoot}/.lando.yml`,
      issues,
    }),
  );
};

const planApp = (
  pluginRegistry: Context.Tag.Service<typeof PluginRegistry>,
  landofile: LandofileShape,
  providerCapabilities: ProviderCapabilities,
): Effect.Effect<AppPlan, LandofileValidationError | CapabilityError> => {
  const appRoot = process.cwd();
  const appName = landofile.name ?? "app";
  const appId = AppId.make(appName);
  const provider = landofile.provider ?? ProviderId.make("lando");
  const metadata = {
    resolvedAt: new Date().toISOString(),
    source: `${appRoot}/.lando.yml`,
    runtime: 4 as const,
  };
  const services: Record<string, unknown> = {};

  return Effect.gen(function* () {
    const manifests = yield* pluginRegistry.list.pipe(
      Effect.mapError(
        (error) =>
          new LandofileValidationError({
            message: `Failed to enumerate plugin contributions: ${error instanceof Error ? error.message : String(error)}.`,
            file: `${appRoot}/.lando.yml`,
            issues: [],
          }),
      ),
    );
    const registeredServiceTypeIds = manifests.flatMap(
      (manifest) => manifest.contributes?.serviceTypes ?? [],
    );

    for (const [name, service] of Object.entries(landofile.services ?? {})) {
      const serviceTypeId = serviceTypeFor(name, service);
      const serviceType = yield* pluginRegistry
        .loadServiceType(serviceTypeId)
        .pipe(
          Effect.mapError(() =>
            unsupportedServiceType(appRoot, name, serviceTypeId, registeredServiceTypeIds),
          ),
        );

      const servicePlan = serviceType.toServicePlan({
        name,
        service,
        appRoot,
        appName,
        provider,
        primary: name === "web",
        metadata,
      });

      if (
        (servicePlan.appMount !== undefined || servicePlan.mounts.some((mount) => mount.type === "bind")) &&
        (!providerCapabilities.bindMounts || providerCapabilities.bindMountPerformance === "none")
      ) {
        return yield* Effect.fail(
          missingCapability(provider, name, "bind mount", "bindMounts", serviceBindRemediation(name)),
        );
      }

      const servicePlanWithCapabilityRealization: ServicePlan = {
        ...servicePlan,
        ...(servicePlan.appMount === undefined
          ? {}
          : { appMount: { ...servicePlan.appMount, realization: bindRealization(providerCapabilities) } }),
        mounts: servicePlan.mounts.map((mount) =>
          mount.type === "bind" ? { ...mount, realization: bindRealization(providerCapabilities) } : mount,
        ),
      };

      if (
        servicePlanWithCapabilityRealization.endpoints.some((endpoint) => endpoint.port !== undefined) &&
        providerCapabilities.hostPortPublish === "none"
      ) {
        return yield* Effect.fail(
          missingCapability(
            provider,
            name,
            "host port publish",
            "hostPortPublish",
            `Choose a provider with host port publish support or remove published ports from service ${name}.`,
          ),
        );
      }

      if (
        servicePlanWithCapabilityRealization.storage.length > 0 &&
        !providerCapabilities.persistentStorage
      ) {
        return yield* Effect.fail(
          missingCapability(
            provider,
            name,
            "persistent storage",
            "persistentStorage",
            `Choose a provider with persistent storage support or remove persistent storage from service ${name}.`,
          ),
        );
      }

      services[name] = Schema.encodeSync(ServicePlan)(servicePlanWithCapabilityRealization);
    }

    return yield* decodeAppPlan(appRoot, {
      id: appId,
      name: appName,
      slug: appName,
      root: AbsolutePath.make(appRoot),
      provider,
      services,
      routes: [],
      networks: [],
      stores: [],
      metadata,
      extensions: {},
    });
  });
};

export const AppPlannerLive = Layer.effect(
  AppPlanner,
  Effect.map(
    PluginRegistry,
    (pluginRegistry): Context.Tag.Service<typeof AppPlanner> => ({
      plan: (landofile, providerCapabilities) => planApp(pluginRegistry, landofile, providerCapabilities),
    }),
  ),
);
