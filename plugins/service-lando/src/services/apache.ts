import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { AbsolutePath, type LogSource, LogSourceId, PortablePath, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

const DEFAULT_IMAGE = "httpd:2.4-alpine";
const DEFAULT_PORT = 80;
const APP_MOUNT_TARGET = PortablePath.make("/app");

const APACHE_LOG_SOURCES: ReadonlyArray<LogSource> = [
  {
    id: LogSourceId.make("access"),
    label: "Apache access log",
    path: AbsolutePath.make("/usr/local/apache2/logs/access_log"),
    stream: "stdout",
    strategy: "redirect",
    required: false,
    timestamps: false,
  },
  {
    id: LogSourceId.make("error"),
    label: "Apache error log",
    path: AbsolutePath.make("/usr/local/apache2/logs/error_log"),
    stream: "stderr",
    strategy: "redirect",
    required: false,
    timestamps: false,
  },
];

export const APACHE_FEATURE_ID = "service-lando.apache" as const;
export const APACHE_FEATURE_PRIORITY = 600;

const applyApacheFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const port = service.port ?? DEFAULT_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.addEnv("APACHE_DOCUMENT_ROOT", "/app");
  ctx.setWorkingDirectory(service.workingDirectory ?? APP_MOUNT_TARGET);
  if (service.user !== undefined) ctx.setUser(service.user);
  const appMount = {
    source: AbsolutePath.make(ctx.appRoot),
    target: APP_MOUNT_TARGET,
    readOnly: false,
    excludes: [],
    includes: [],
    realization: "passthrough" as const,
  };
  const bindMount = {
    type: "bind" as const,
    source: ctx.appRoot,
    target: APP_MOUNT_TARGET,
    readOnly: false,
    realization: "passthrough" as const,
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

export const apacheServiceFeature: ServiceFeatureDefinition = {
  id: APACHE_FEATURE_ID,
  schema: Schema.Unknown,
  priority: APACHE_FEATURE_PRIORITY,
  apply: (ctx) =>
    Effect.try({
      try: () => applyApacheFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "service-lando.apache failed to apply",
          feature: APACHE_FEATURE_ID,
          cause,
        }),
    }),
};

export const apacheServiceType: ServiceType = {
  id: "apache",
  name: "apache",
  base: "lando",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "lando" as const,
      normalizedConfig: { ...input.service, type: "apache" },
      logSources: APACHE_LOG_SOURCES,
      features: [
        { id: APACHE_FEATURE_ID },
        {
          id: "lando.env",
          config: { appPaths: { appRoot: "/app", projectMount: "/app" }, webroot: "/app" },
        },
      ],
    }),
};
