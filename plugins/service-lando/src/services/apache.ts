import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { AbsolutePath, type LogSource, LogSourceId, PortNumber, PortablePath } from "@lando/sdk/schema";
import type {
  ServiceBuildStepIntent,
  ServiceFeatureContext,
  ServiceFeatureDefinition,
  ServiceType,
} from "@lando/sdk/services";

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

export const APACHE_LISTEN_BUILD_STEP_ID = "service-lando.apache:listen" as const;

/** Where each bundled Apache family declares the listener Lando has to retire. */
export const HTTPD_CONF_PATH = "/usr/local/apache2/conf/httpd.conf" as const;
export const DEBIAN_APACHE_PORTS_CONF_PATH = "/etc/apache2/ports.conf" as const;

/** The authored `port:`, validated as a port before it reaches a directive. */
export const authoredListenPort = (port: number | undefined): number | undefined =>
  port === undefined ? undefined : Schema.decodeUnknownSync(PortNumber)(port);

/**
 * Retires the listener the base image declares, so a generated `Listen` is the
 * only one left.
 *
 * `Listen` is additive and command-line directives are read after the
 * configuration tree, so no directive can withdraw the image's own `Listen 80`.
 * Emitting one alone would open a second socket rather than move the first.
 * Deleting the line during the image build is what leaves exactly one listener,
 * and it costs a derived image only for a service that authored a `port:`.
 *
 * The step is fail-closed on both sides of the edit. If the base image ever
 * stops declaring exactly one active `Listen 80`, the build stops here instead
 * of producing a service that quietly answers on two ports.
 */
export const apacheListenBuildStep = (configPath: string): ServiceBuildStepIntent => ({
  id: APACHE_LISTEN_BUILD_STEP_ID,
  phase: "build",
  user: "root",
  command: [
    "sh",
    "-c",
    [
      "set -eu",
      `test -f ${configPath}`,
      `before=$(grep -c '^Listen 80$' ${configPath} || true)`,
      `test "$before" = "1" || { echo "lando: expected one active Listen 80 in ${configPath}, found $before" >&2; exit 1; }`,
      `sed -i '/^Listen 80$/d' ${configPath}`,
      `after=$(grep -c '^Listen 80$' ${configPath} || true)`,
      `test "$after" = "0" || { echo "lando: Listen 80 survived in ${configPath}" >&2; exit 1; }`,
    ].join("; "),
  ],
});

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
 *
 * An authored `port:` becomes a `Listen` directive in that same stream, paired
 * with the build step that retires the image's own listener.
 */
const apacheStartCommand = (webroot: string, listenPort: number | undefined): ReadonlyArray<string> => {
  const path = apacheDirectivePath(webroot);
  return [
    "httpd-foreground",
    ...(listenPort === undefined ? [] : ["-c", `Listen ${String(listenPort)}`]),
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
  const listenPort = authoredListenPort(service.port);
  const port = listenPort ?? DEFAULT_PORT;
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
    const ownedListen =
      service.image === undefined || service.image === DEFAULT_IMAGE ? listenPort : undefined;
    ctx.setCommand(apacheStartCommand(documentRoot, ownedListen));
    if (ownedListen !== undefined) ctx.addBuildStep(apacheListenBuildStep(HTTPD_CONF_PATH));
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
