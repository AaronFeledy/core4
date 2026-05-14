import { type Context, Effect, Either, Layer, ParseResult, Schema } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  AppPlan,
  type LandofileShape,
  PortablePath,
  type ProviderCapabilities,
  ProviderId,
  type ServiceConfig,
  ServiceName,
} from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";

export { AppPlanner } from "@lando/sdk/services";

const APP_MOUNT_TARGET = PortablePath.make("/app");

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
  if (service.image?.startsWith("node:")) return "node";
  if (service.image?.startsWith("postgres")) return "postgres";
  return name;
};

const endpointProtocolFor = (serviceType: string): "http" | "tcp" =>
  serviceType === "node" ? "http" : "tcp";

const parseContainerPort = (port: string): number | undefined => {
  const containerPort = port.split(":").at(-1)?.split("/")[0];
  if (containerPort === undefined) return undefined;
  const parsed = Number(containerPort);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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
  const appMount = {
    source: AbsolutePath.make(appRoot),
    target: APP_MOUNT_TARGET,
    readOnly: false,
    excludes: [],
    includes: [],
    realization: "passthrough" as const,
  };
  const services: Record<string, unknown> = {};

  for (const [name, service] of Object.entries(landofile.services ?? {})) {
    const serviceType = serviceTypeFor(name, service);
    if (serviceType !== "node" && serviceType !== "postgres") {
      return Effect.fail(unsupportedServiceType(appRoot, name, serviceType));
    }

    services[name] = {
      name: ServiceName.make(name),
      type: serviceType,
      provider,
      primary: service.primary ?? name === "web",
      artifact: service.image === undefined ? undefined : { kind: "ref" as const, ref: service.image },
      command: service.command,
      entrypoint: service.entrypoint,
      environment: service.environment ?? {},
      user: service.user,
      workingDirectory: service.workingDirectory,
      appMount,
      mounts: [
        {
          type: "bind" as const,
          source: appRoot,
          target: APP_MOUNT_TARGET,
          readOnly: false,
          realization: "passthrough" as const,
        },
      ],
      storage: [],
      endpoints: (service.ports ?? []).flatMap((port) => {
        const containerPort = parseContainerPort(port);
        return containerPort === undefined
          ? []
          : [{ port: containerPort, protocol: endpointProtocolFor(serviceType), name }];
      }),
      routes: [],
      dependsOn: (service.dependsOn ?? []).map((dependency) => ({
        service: ServiceName.make(dependency),
        condition: "started" as const,
      })),
      hostAliases: [],
      metadata,
      extensions: {},
    };
  }

  return decodeAppPlan(appRoot, {
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
};

const appPlannerService: Context.Tag.Service<typeof AppPlanner> = {
  plan: planApp,
};

export const AppPlannerLive = Layer.succeed(AppPlanner, appPlannerService);
