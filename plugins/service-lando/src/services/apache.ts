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

export const apacheDirectivePath = (webroot: string): string => {
  if (/\r|\n/u.test(webroot)) {
    throw new Error("Apache webroot must not contain line breaks.");
  }
  return webroot.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
};

/**
 * Apache's compiled default `PidFile` sits under the root-owned
 * `/usr/local/apache2/logs`, and httpd exits when it cannot create it. Pointing
 * the pid file somewhere every identity may write is what lets the planned
 * service user own PID 1.
 */
const PID_FILE = "/tmp/lando-httpd.pid";

/**
 * The launcher for a service whose author declared no `command` or `entrypoint`.
 *
 * Every directive is handed to httpd as a repeated `-c` argument instead of
 * being written to a config file at startup. httpd reads those arguments as
 * consecutive lines of one synthetic configuration stream at the same stage that
 * used to process `-c 'Include ...'`, so a `<Directory>` section spans the
 * arguments exactly as it spanned the file's lines and the resulting
 * configuration is unchanged. Emitting them directly is what removes the write:
 * the command mutates no filesystem path, needs no shell, and therefore runs
 * unchanged as the planned service user rather than only as root.
 */
const apacheStartCommand = (webroot: string): ReadonlyArray<string> => {
  const path = apacheDirectivePath(webroot);
  return [
    "httpd-foreground",
    "-c",
    `PidFile "${PID_FILE}"`,
    "-c",
    `DocumentRoot "${path}"`,
    "-c",
    `<Directory "${path}">`,
    "-c",
    "Options -Indexes +FollowSymLinks",
    "-c",
    "AllowOverride None",
    "-c",
    "Require all granted",
    "-c",
    "</Directory>",
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
  // Verified from /etc/passwd in docker.io/library/httpd:2.4-alpine (HTTPD_VERSION=2.4.68):
  // sha256:7ed5668e2fb31c738bcd291847fbb313073998e561ac6d8dc63cfd061dd0fb4d
  // www-data:x:82:82::/home/www-data:/sbin/nologin
  // Image config User was empty and HOME was absent, so neither was used as the home source.
  identity: { defaultUser: "root", homes: { root: "/root", "www-data": "/home/www-data" } },
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
