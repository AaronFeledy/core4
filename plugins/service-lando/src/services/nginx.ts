import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { AbsolutePath, PortablePath, type ServiceConfig, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

const DEFAULT_IMAGE = "nginx:1.26-alpine";
const DEFAULT_PORT = 80;
const APP_MOUNT_TARGET = PortablePath.make("/app");

export const NGINX_FEATURE_ID = "service-lando.nginx" as const;
export const NGINX_FEATURE_PRIORITY = 600;

const applyNginxFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const port = service.port ?? DEFAULT_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.setWorkingDirectory(service.workingDirectory ?? APP_MOUNT_TARGET);
  if (service.user !== undefined) ctx.setUser(service.user);
  const passthrough = { realization: "passthrough" as const };
  const appMount = {
    source: AbsolutePath.make(ctx.appRoot),
    target: APP_MOUNT_TARGET,
    readOnly: false,
    excludes: [],
    includes: [],
    ...passthrough,
  };
  const bindMount = {
    type: "bind" as const,
    source: ctx.appRoot,
    target: APP_MOUNT_TARGET,
    readOnly: false,
    ...passthrough,
  };
  ctx.setAppMount(appMount);
  ctx.addMount(bindMount);
  ctx.addEndpoint({ port, protocol: "http", name: ctx.serviceName });
  ctx.setHealthcheck({
    kind: "command",
    command: ["sh", "-c", `nc -z 127.0.0.1 ${port}`],
    intervalSeconds: 10,
    timeoutSeconds: 5,
    retries: 5,
    startPeriodSeconds: 10,
  });

  if (service.command !== undefined) ctx.setCommand(service.command);
  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  for (const dependency of service.dependsOn ?? []) {
    ctx.addDependency({ service: ServiceName.make(dependency), condition: "started" });
  }
};

export const nginxServiceFeature: ServiceFeatureDefinition = {
  id: NGINX_FEATURE_ID,
  schema: Schema.Unknown,
  priority: NGINX_FEATURE_PRIORITY,
  apply: (ctx) =>
    Effect.try({
      try: () => applyNginxFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "service-lando.nginx failed to apply",
          feature: NGINX_FEATURE_ID,
          cause,
        }),
    }),
};

const normalizedService = (service: ServiceConfig): ServiceConfig => ({
  ...service,
  type: "nginx",
});

export const nginxServiceType: ServiceType = {
  id: "nginx",
  name: "nginx",
  base: "lando",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "lando" as const,
      normalizedConfig: normalizedService(input.service),
      features: [
        { id: NGINX_FEATURE_ID },
        {
          id: "lando.env",
          config: { appPaths: { appRoot: "/app", projectMount: "/app" }, webroot: "/app" },
        },
      ],
    }),
};
