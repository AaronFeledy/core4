import { type Context, Effect, Either, Layer, ParseResult, Schema } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
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
  if (service.image?.startsWith("node:")) return "node:lts";
  if (service.image?.startsWith("postgres")) return "postgres";
  return name;
};

const unsupportedServiceType = (appRoot: string, serviceName: string, serviceType: string) =>
  new LandofileValidationError({
    message: `Unsupported service type ${serviceType} for service ${serviceName}.`,
    file: `${appRoot}/.lando.yml`,
    issues: [`services.${serviceName}.type`],
  });

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
  _providerCapabilities: ProviderCapabilities,
): Effect.Effect<AppPlan, LandofileValidationError> => {
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
    for (const [name, service] of Object.entries(landofile.services ?? {})) {
      const serviceTypeId = serviceTypeFor(name, service);
      const serviceType = yield* pluginRegistry
        .loadServiceType(serviceTypeId)
        .pipe(Effect.mapError(() => unsupportedServiceType(appRoot, name, serviceTypeId)));

      services[name] = Schema.encodeSync(ServicePlan)(
        serviceType.toServicePlan({
          name,
          service,
          appRoot,
          provider,
          primary: name === "web",
          metadata,
        }),
      );
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
