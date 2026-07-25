import { Effect, Schema } from "effect";

import { ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type LogSource,
  LogSourceId,
  PortablePath,
  type ServiceConfig,
  ServiceName,
} from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { addServicePortEndpoints } from "./_port-helpers.ts";
import { phpPrerequisiteBuildSteps } from "./php-prerequisites.ts";

export {
  PHP_APT_PACKAGE_PINS,
  PHP_COMMON_EXTENSIONS,
  PHP_COMPOSER,
  PHP_COMPOSER_COMMAND,
  PHP_PREREQUISITES_COMMAND,
} from "./php-prerequisites.ts";

export const SUPPORTED_PHP_VERSIONS = ["8.1", "8.2", "8.3", "8.4"] as const;
export type SupportedPhpVersion = (typeof SUPPORTED_PHP_VERSIONS)[number];

export const PHP_FEATURE_ID = "service-lando.php" as const;
export const PHP_FEATURE_PRIORITY = 600;

const APP_MOUNT_TARGET = PortablePath.make("/app");
const HEALTHCHECK_PORT = 80;
const PhpWebroot = Schema.String.pipe(
  Schema.pattern(/^\/[A-Za-z0-9._/-]*$/u, {
    message: () =>
      "PHP webroot must be an absolute container path using only letters, digits, '.', '_', '-', and '/'.",
  }),
  Schema.brand("PhpWebroot"),
);

const PHP_FPM_LOG_SOURCES: ReadonlyArray<LogSource> = [
  {
    id: LogSourceId.make("access"),
    label: "php-fpm access log",
    path: AbsolutePath.make("/var/log/php-fpm/access.log"),
    stream: "stdout",
    strategy: "redirect",
    required: false,
    timestamps: false,
  },
  {
    id: LogSourceId.make("error"),
    label: "php-fpm error log",
    path: AbsolutePath.make("/var/log/php-fpm/error.log"),
    stream: "stderr",
    strategy: "redirect",
    required: false,
    timestamps: false,
  },
];

const PhpFeatureConfigSchema = Schema.Struct({
  allowOverride: Schema.Boolean,
  version: Schema.Literal(...SUPPORTED_PHP_VERSIONS),
  webroot: PhpWebroot,
});
type PhpFeatureConfig = typeof PhpFeatureConfigSchema.Type;

const REMEDIATION_VERSION = (requested: string): string =>
  `Set type to one of: ${SUPPORTED_PHP_VERSIONS.map((v) => `php:${v}`).join(", ")} (got php:${requested}).`;

const validateVersion = (
  declaredType: string | undefined,
  fallback: SupportedPhpVersion,
): SupportedPhpVersion => {
  if (declaredType === undefined) return fallback;
  if (!declaredType.startsWith("php:")) return fallback;
  const version = declaredType.slice("php:".length);
  if ((SUPPORTED_PHP_VERSIONS as ReadonlyArray<string>).includes(version)) {
    return version as SupportedPhpVersion;
  }
  throw new Error(`Unsupported PHP version "${version}". ${REMEDIATION_VERSION(version)}`);
};

const configFor = (ctx: ServiceFeatureContext): PhpFeatureConfig => ctx.config as PhpFeatureConfig;

const apacheStartCommand = (webroot: string, allowOverride: boolean): ReadonlyArray<string> => {
  const override = allowOverride ? "All" : "None";
  return [
    "sh",
    "-c",
    [
      "set -eu",
      "cat > /etc/apache2/sites-available/000-default.conf <<'LANDO_APACHE_SITE'",
      "<VirtualHost *:80>",
      `  DocumentRoot ${webroot}`,
      `  <Directory ${webroot}>`,
      "    Options -Indexes +FollowSymLinks",
      `    AllowOverride ${override}`,
      "    Require all granted",
      "  </Directory>",
      "</VirtualHost>",
      "LANDO_APACHE_SITE",
      "exec apache2-foreground",
    ].join("\n"),
  ];
};

const applyPhpFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { allowOverride, version, webroot } = configFor(ctx);
  const port = service.port ?? HEALTHCHECK_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? `php:${version}-apache-bookworm` });
  if (service.image === undefined) {
    for (const step of phpPrerequisiteBuildSteps()) ctx.addBuildStep(step);
    ctx.setCommand(apacheStartCommand(webroot, allowOverride));
  }
  ctx.setWorkingDirectory(service.workingDirectory ?? PortablePath.make(webroot));
  ctx.addEnv("APACHE_DOCUMENT_ROOT", webroot);
  ctx.setAppMount({
    source: AbsolutePath.make(ctx.appRoot),
    target: APP_MOUNT_TARGET,
    readOnly: false,
    excludes: [],
    includes: [],
  });
  ctx.addMount({
    type: "bind",
    source: ctx.appRoot,
    target: APP_MOUNT_TARGET,
    readOnly: false,
  });
  addServicePortEndpoints(ctx, { port, protocol: "http" });
  ctx.setHealthcheck({
    kind: "command",
    command: ["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`],
    intervalSeconds: 10,
    timeoutSeconds: 5,
    retries: 5,
    startPeriodSeconds: 10,
  });

  for (const dependency of service.dependsOn ?? []) {
    ctx.addDependency({ service: ServiceName.make(dependency), condition: "started" });
  }
  if (service.user !== undefined) ctx.setUser(service.user);
  if (service.command !== undefined) ctx.setCommand(service.command);
  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);

  ctx.addExtension("lando-service-php", {
    allowOverride,
    webroot,
    version,
  });
};

export const phpServiceFeature: ServiceFeatureDefinition = {
  id: PHP_FEATURE_ID,
  schema: PhpFeatureConfigSchema as Schema.Schema<unknown>,
  priority: PHP_FEATURE_PRIORITY,
  apply: (ctx) =>
    Effect.try({
      try: () => applyPhpFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "service-lando.php failed to apply",
          feature: PHP_FEATURE_ID,
          cause,
        }),
    }),
};

const normalizedService = (service: ServiceConfig, resolvedVersion: SupportedPhpVersion): ServiceConfig => ({
  ...service,
  type: `php:${resolvedVersion}`,
});

const makePhpServiceType = (version: SupportedPhpVersion): ServiceType => ({
  id: `php:${version}`,
  name: `php:${version}`,
  base: "lando",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.try({
      try: () => {
        const resolvedVersion = validateVersion(input.service.type, version);
        const webroot = Schema.decodeUnknownSync(PhpWebroot)(input.service.webroot ?? APP_MOUNT_TARGET);
        const allowOverride = input.service.allowOverride ?? false;

        return {
          base: "lando" as const,
          normalizedConfig: normalizedService(input.service, resolvedVersion),
          logSources: PHP_FPM_LOG_SOURCES,
          features: [
            { id: PHP_FEATURE_ID, config: { allowOverride, version: resolvedVersion, webroot } },
            {
              id: "lando.env",
              config: { appPaths: { appRoot: "/app", projectMount: "/app" }, webroot },
            },
          ],
        };
      },
      catch: (cause) =>
        new ServiceTypeError({
          message: cause instanceof Error ? cause.message : `Failed to resolve php:${version}`,
          serviceType: `php:${version}`,
          cause,
        }),
    }),
});

export const php81ServiceType: ServiceType = makePhpServiceType("8.1");
export const php82ServiceType: ServiceType = makePhpServiceType("8.2");
export const php83ServiceType: ServiceType = makePhpServiceType("8.3");
export const php84ServiceType: ServiceType = makePhpServiceType("8.4");
