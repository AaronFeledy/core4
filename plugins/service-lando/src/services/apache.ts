import {
  AbsolutePath,
  type LogSource,
  LogSourceId,
  PortNumber,
  type ServiceConfig,
  type ValidationIssuePath,
  sameImageReference,
} from "@lando/sdk/schema";
import type {
  ServiceBuildStepIntent,
  ServiceFeatureContext,
  ServiceFeatureDefinition,
  ServiceType,
} from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { UNSUPPORTED_LAUNCHER_EXTRA_ARGS_REMEDIATION } from "./_extra-args.ts";
import {
  ServiceConfigIssue,
  literalEnvironmentValue,
  rootIdentity,
  serviceFeatureApply,
  serviceFeatureValidateEffective,
  serviceTypeResolve,
} from "./_feature-helpers.ts";
import {
  imageAuthority,
  launcherAuthority,
  primaryPortSelector,
  servicePortEndpoints,
} from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { tcpProbe } from "./_tcp-probe.ts";
import { resolveWebroot } from "./_webroot.ts";
import {
  type ApacheNativeTls,
  apacheGeneratedCertificateEndpoint,
  generatedHttpsEndpoint,
  nativeTlsEligible,
  nativeTlsListener,
  nativeTlsVirtualHosts,
} from "./apache-native-tls.ts";
import { apacheHiddenPathDirectives } from "./http-hidden-paths.ts";

export const DEFAULT_IMAGE = "httpd:2.4-alpine";
export const APACHE_LISTENER = {
  port: 80,
  daemon: "Apache",
  when: "All Apache services",
  launcher: { setting: (port: number) => `Listen ${port}` },
  image: { setting: (port: number) => `Listen ${port}` },
} as const;
export const DEFAULT_PORT = APACHE_LISTENER.port;
const selectPort = primaryPortSelector(APACHE_LISTENER);
export const APP_MOUNT_TARGET = "/app";

/**
 * Whether this standalone Apache service still uses Lando's own launcher. Only a
 * replacement `build.context` takes over the image; additive build steps do not.
 */
export const apacheOwnedLauncher = (
  service: Pick<ServiceConfig, "image" | "build" | "command" | "entrypoint">,
): boolean =>
  service.command === undefined &&
  service.entrypoint === undefined &&
  !(service.build !== undefined && "context" in service.build) &&
  (service.image === undefined || sameImageReference(service.image, DEFAULT_IMAGE));

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
export const APACHE_SSL_MODULE_BUILD_STEP_ID = "service-lando.apache:ssl-module" as const;
export const APACHE_SSL_PORTS_BUILD_STEP_ID = "service-lando.apache:ssl-ports" as const;

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

/**
 * Loads httpd Alpine's shipped SSL modules at image-build time and leaves the
 * stock SSL sample virtual host disabled, so exactly the launcher's own TLS
 * listener and virtual host exist. Fail-closed: both `LoadModule` lines must be
 * present exactly once in their commented form before the edit.
 */
export const apacheSslModuleBuildStep = (configPath: string): ServiceBuildStepIntent => {
  const modules = ["socache_shmcb_module modules/mod_socache_shmcb.so", "ssl_module modules/mod_ssl.so"];
  return {
    id: APACHE_SSL_MODULE_BUILD_STEP_ID,
    phase: "build",
    user: "root",
    command: [
      "sh",
      "-c",
      [
        "set -eu",
        `test -f ${configPath}`,
        ...modules.flatMap((module) => [
          `before=$(grep -c '^#LoadModule ${module}$' ${configPath} || true)`,
          `test "$before" = "1" || { echo "lando: expected one commented LoadModule for ${module} in ${configPath}, found $before" >&2; exit 1; }`,
          `sed -i 's|^#LoadModule ${module}$|LoadModule ${module}|' ${configPath}`,
          `after=$(grep -c '^LoadModule ${module}$' ${configPath} || true)`,
          `test "$after" = "1" || { echo "lando: LoadModule ${module} is not active exactly once in ${configPath}" >&2; exit 1; }`,
        ]),
        `included=$(grep -c '^Include conf/extra/httpd-ssl.conf$' ${configPath} || true)`,
        `test "$included" = "0" || { echo "lando: the stock SSL virtual host is enabled in ${configPath}" >&2; exit 1; }`,
      ].join("; "),
    ],
  };
};

/**
 * Enables Debian Apache's `ssl` module (and the dependencies `a2enmod` pulls in)
 * and retires the conditional `Listen 443` lines its `ports.conf` adds, so the
 * launcher's own `Listen` remains the single definition of each planned
 * listener. Fail-closed on any surviving active 443 listener.
 */
export const apacheDebianSslBuildStep = (): ServiceBuildStepIntent => ({
  id: APACHE_SSL_PORTS_BUILD_STEP_ID,
  phase: "build",
  user: "root",
  command: [
    "sh",
    "-c",
    [
      "set -eu",
      `test -f ${DEBIAN_APACHE_PORTS_CONF_PATH}`,
      "a2enmod ssl",
      `sed -i '/<IfModule ssl_module>/,/<\\/IfModule>/d; /<IfModule mod_gnutls.c>/,/<\\/IfModule>/d' ${DEBIAN_APACHE_PORTS_CONF_PATH}`,
      `left=$(grep -c '^[[:space:]]*Listen 443$' ${DEBIAN_APACHE_PORTS_CONF_PATH} || true)`,
      `test "$left" = "0" || { echo "lando: ports.conf still declares Listen 443" >&2; exit 1; }`,
    ].join("; "),
  ],
});

export const apacheDirectivePath = (webroot: string, path: ValidationIssuePath = ["webroot"]): string => {
  if (/\r|\n/u.test(webroot)) {
    throw new ServiceConfigIssue(
      path,
      "Apache webroot must not contain line breaks.",
      "Use a single-line container path.",
    );
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
 * with the build step that retires the image's own listener. With native TLS the
 * same document-root, access, and hidden-path policy is rendered twice: a plain
 * listener and one TLS listener whose virtual host is the only one for that
 * port, because the stock SSL sample host stays disabled at build time.
 */
const apacheStartCommand = (
  webroot: string,
  listenPort: number | undefined,
  issuePath: ValidationIssuePath,
  tls?: ApacheNativeTls,
): ReadonlyArray<string> => {
  const path = apacheDirectivePath(webroot, issuePath);
  const site = [
    `DocumentRoot "${path}"`,
    `<Directory "${path}">`,
    "Options -Indexes +FollowSymLinks",
    "AllowOverride None",
    "Require all granted",
    "</Directory>",
    ...apacheHiddenPathDirectives(),
  ];
  const flags = (directives: ReadonlyArray<string>) => directives.flatMap((directive) => ["-c", directive]);
  const directives = ["httpd-foreground", "-c", "ServerName localhost"];
  if (tls === undefined) {
    directives.push(
      ...(listenPort === undefined ? [] : ["-c", `Listen ${String(listenPort)}`]),
      "-c",
      `PidFile "${PID_FILE}"`,
      ...flags(site),
    );
  } else {
    // The image's own plain listener stays in its configuration; an authored
    // port already retired it at build time, so it must be re-declared here.
    directives.push(...(listenPort === undefined ? [] : ["-c", `Listen ${String(listenPort)}`]));
    directives.push(
      "-c",
      `Listen ${String(tls.tlsPort)}`,
      "-c",
      `PidFile "${PID_FILE}"`,
      ...flags(
        nativeTlsVirtualHosts({
          family: "standalone-apache",
          plainPort: tls.plainPort,
          tlsPort: tls.tlsPort,
          serverName: tls.serverName,
          plainSite: site,
          tlsSite: site,
        }),
      ),
    );
  }
  return directives;
};

const applyApacheFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const listenPort = authoredListenPort(service.port);
  const port = selectPort(service);
  const webroot = resolveWebroot("Apache", service.webroot, service.appMount);
  const documentRoot = service.environment?.APACHE_DOCUMENT_ROOT ?? webroot;
  const owned = apacheOwnedLauncher(service);
  const nativeTls = nativeTlsEligible({ owned, config: service });

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.addEnv("APACHE_DOCUMENT_ROOT", webroot);
  applyAuthoredProcessFields(ctx, ["user"]);
  ctx.setHealthcheck(tcpProbe(port, 10));

  if (service.command === undefined && service.entrypoint === undefined) {
    ctx.setCommand(
      apacheStartCommand(
        literalEnvironmentValue(documentRoot, ["environment", "APACHE_DOCUMENT_ROOT"]),
        owned ? listenPort : undefined,
        service.environment?.APACHE_DOCUMENT_ROOT === undefined
          ? ["webroot"]
          : ["environment", "APACHE_DOCUMENT_ROOT"],
        nativeTls
          ? nativeTlsListener({
              plainPort: port,
              serviceName: ctx.serviceName,
              appName: ctx.appName ?? "app",
              appRoot: ctx.appRoot,
            })
          : undefined,
      ),
    );
    if (owned && listenPort !== undefined) ctx.addBuildStep(apacheListenBuildStep(HTTPD_CONF_PATH));
    if (nativeTls) ctx.addBuildStep(apacheSslModuleBuildStep(HTTPD_CONF_PATH));
    if (!owned) ctx.setListenerAuthority(imageAuthority(APACHE_LISTENER, port));
  } else {
    ctx.setListenerAuthority(launcherAuthority(APACHE_LISTENER, port));
  }
  applyAuthoredProcessFields(ctx, ["command", "entrypoint"]);
};

export const apacheServiceFeature: ServiceFeatureDefinition = {
  id: APACHE_FEATURE_ID,
  schema: Schema.Unknown,
  priority: APACHE_FEATURE_PRIORITY,
  validateEffective: serviceFeatureValidateEffective(APACHE_FEATURE_ID, (ctx) => {
    resolveWebroot("Apache", ctx.normalizedConfig.webroot, ctx.normalizedConfig.appMount);
    return { handledServiceFields: ["webroot"] };
  }),
  declareEndpoints: (ctx) =>
    Effect.sync(() => {
      const port = selectPort(ctx.normalizedConfig);
      const endpoints = servicePortEndpoints(ctx, { port, protocol: "http" });
      const owned = apacheOwnedLauncher(ctx.normalizedConfig);
      return nativeTlsEligible({ owned, config: ctx.normalizedConfig })
        ? [...endpoints, generatedHttpsEndpoint({ serviceName: ctx.serviceName, plainPort: port })]
        : endpoints;
    }),
  apply: serviceFeatureApply(APACHE_FEATURE_ID, "service-lando.apache failed to apply", applyApacheFeature),
};

export const apacheServiceType: ServiceType = {
  id: "apache",
  name: "apache",
  base: "lando",
  plannedPort: selectPort,
  extraArgsRemediation: UNSUPPORTED_LAUNCHER_EXTRA_ARGS_REMEDIATION(
    "Apache",
    "Put flags in command: or configure the generated httpd launcher through type settings.",
  ),
  // Verified from /etc/passwd in docker.io/library/httpd:2.4-alpine (HTTPD_VERSION=2.4.68):
  // sha256:7ed5668e2fb31c738bcd291847fbb313073998e561ac6d8dc63cfd061dd0fb4d
  // www-data:x:82:82::/home/www-data:/sbin/nologin
  // Image config User was empty and HOME was absent, so neither was used as the home source.
  identity: rootIdentity({ "www-data": "/home/www-data" }),
  schema: Schema.Unknown,
  resolve: (input) =>
    serviceTypeResolve("apache", "Failed to resolve apache", () => {
      const webroot = resolveWebroot("Apache", input.service.webroot, input.service.appMount);
      const endpoint = apacheGeneratedCertificateEndpoint({
        plainPort: selectPort(input.service),
        owned: apacheOwnedLauncher(input.service),
      });
      return {
        base: "lando" as const,
        normalizedConfig: { ...input.service, type: "apache" },
        logSources: APACHE_LOG_SOURCES,
        ...(endpoint === undefined ? {} : { generatedCertificateEndpoint: endpoint }),
        features: [
          { id: APACHE_FEATURE_ID },
          {
            id: "lando.env",
            config: { webroot },
          },
          { id: "lando.app-mount", config: { target: APP_MOUNT_TARGET } },
        ],
      };
    }),
};
