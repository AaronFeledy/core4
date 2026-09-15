import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { AbsolutePath, type LogSource, LogSourceId, PortablePath } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { addServicePortEndpoints } from "./_port-helpers.ts";

const DEFAULT_IMAGE = "httpd:2.4-alpine";
const DEFAULT_PORT = 80;
const APP_MOUNT_TARGET = PortablePath.make("/app");
const DEFAULT_WEBROOT = "/app";

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

const apacheConfigPath = (webroot: string): string => {
  if (/\r|\n/u.test(webroot)) {
    throw new Error("Apache webroot must not contain line breaks.");
  }
  return webroot.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
};

const apacheStartCommand = (webroot: string): ReadonlyArray<string> => {
  const path = apacheConfigPath(webroot);
  return [
    "sh",
    "-c",
    [
      "set -eu",
      "cat > /usr/local/apache2/conf/extra/lando-webroot.conf <<'LANDO_APACHE_WEBROOT'",
      `DocumentRoot "${path}"`,
      `<Directory "${path}">`,
      "  Options -Indexes +FollowSymLinks",
      "  AllowOverride None",
      "  Require all granted",
      "</Directory>",
      "LANDO_APACHE_WEBROOT",
      "exec httpd-foreground -c 'Include conf/extra/lando-webroot.conf'",
    ].join("\n"),
  ];
};

const applyApacheFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const port = service.port ?? DEFAULT_PORT;
  const webroot = service.webroot ?? DEFAULT_WEBROOT;
  const documentRoot = service.environment?.APACHE_DOCUMENT_ROOT ?? webroot;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.addEnv("APACHE_DOCUMENT_ROOT", webroot);
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
  addServicePortEndpoints(ctx, { port, protocol: "http" });
  ctx.setHealthcheck({
    kind: "command",
    command: ["sh", "-c", `nc -z 127.0.0.1 ${port}`],
    intervalSeconds: 10,
    timeoutSeconds: 5,
    retries: 5,
    startPeriodSeconds: 10,
  });

  if (service.command === undefined && service.entrypoint === undefined) {
    ctx.setCommand(apacheStartCommand(documentRoot));
  }
  if (service.command !== undefined) ctx.setCommand(service.command);
  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
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
  identity: { defaultUser: "root", homes: { root: "/root" } },
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.sync(() => {
      const webroot = input.service.webroot ?? DEFAULT_WEBROOT;
      return {
        base: "lando" as const,
        normalizedConfig: { ...input.service, type: "apache" },
        logSources: APACHE_LOG_SOURCES,
        features: [
          { id: APACHE_FEATURE_ID },
          {
            id: "lando.env",
            config: { appPaths: { appRoot: "/app", projectMount: "/app" }, webroot },
          },
        ],
      };
    }),
};
