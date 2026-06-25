import { Effect, Schema } from "effect";

import { ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";
import { AbsolutePath, PortablePath, type ServiceConfig, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

export const SUPPORTED_PHP_VERSIONS = ["8.2", "8.3"] as const;
export type SupportedPhpVersion = (typeof SUPPORTED_PHP_VERSIONS)[number];

export const SUPPORTED_PHP_FRAMEWORKS = ["drupal", "wordpress", "laravel", "symfony", "none"] as const;
export type SupportedPhpFramework = (typeof SUPPORTED_PHP_FRAMEWORKS)[number];

export const PHP_FEATURE_ID = "service-lando.php" as const;
export const PHP_FEATURE_PRIORITY = 600;

const APP_MOUNT_TARGET = PortablePath.make("/app");
const HEALTHCHECK_PORT = 80;

export const FRAMEWORK_WEBROOTS: Record<SupportedPhpFramework, string> = {
  drupal: "web",
  wordpress: "",
  laravel: "public",
  symfony: "public",
  none: "",
};

export const frameworkWebrootPath = (framework: SupportedPhpFramework): string => {
  const rel = FRAMEWORK_WEBROOTS[framework];
  return rel === "" ? "/app" : `/app/${rel}`;
};

const PhpFeatureConfigSchema = Schema.Struct({
  framework: Schema.Literal(...SUPPORTED_PHP_FRAMEWORKS),
  version: Schema.Literal(...SUPPORTED_PHP_VERSIONS),
  webroot: Schema.String,
});
type PhpFeatureConfig = typeof PhpFeatureConfigSchema.Type;

const REMEDIATION_VERSION = (requested: string): string =>
  `Set type to one of: ${SUPPORTED_PHP_VERSIONS.map((v) => `php:${v}`).join(", ")} (got php:${requested}).`;

const REMEDIATION_FRAMEWORK = (requested: string): string =>
  `Set framework to one of: ${SUPPORTED_PHP_FRAMEWORKS.join(", ")} (got ${requested}).`;

const validateFramework = (raw: string | undefined): SupportedPhpFramework => {
  if (raw === undefined) return "none";
  if ((SUPPORTED_PHP_FRAMEWORKS as ReadonlyArray<string>).includes(raw)) {
    return raw as SupportedPhpFramework;
  }
  throw new Error(`Unsupported PHP framework "${raw}". ${REMEDIATION_FRAMEWORK(raw)}`);
};

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

const applyPhpFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { framework, version, webroot } = configFor(ctx);
  const port = service.port ?? HEALTHCHECK_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? `php:${version}-apache` });
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
  ctx.addEndpoint({ port, protocol: "http", name: ctx.serviceName });
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
    framework,
    webroot: frameworkWebrootPath(framework),
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
        const framework = validateFramework(input.service.framework);
        const webroot = frameworkWebrootPath(framework);

        return {
          base: "lando" as const,
          normalizedConfig: normalizedService(input.service, resolvedVersion),
          features: [
            { id: PHP_FEATURE_ID, config: { framework, version: resolvedVersion, webroot } },
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

export const php82ServiceType: ServiceType = makePhpServiceType("8.2");
export const php83ServiceType: ServiceType = makePhpServiceType("8.3");
