import { Effect, Schema } from "effect";

import { ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";
import { AbsolutePath, PortablePath, type ServiceConfig } from "@lando/sdk/schema";
import { PhpServiceConfig } from "@lando/sdk/schema/services/php";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { addServicePortEndpoints } from "./_port-helpers.ts";
import { resolvePhpDbClient } from "./php-db-client.ts";
import { phpPrerequisiteBuildSteps, resolvePhpComposer } from "./php-prerequisites.ts";
import {
  PHP_CLI_KEEP_ALIVE,
  PHP_FPM_LOG_SOURCES,
  type PhpVia,
  apacheStartCommand,
  assertPhpViaKeys,
  fpmStartCommand,
  phpEndpointProtocol,
  phpImageFor,
  phpListenPort,
  resolvePhpVia,
} from "./php-via.ts";
import { phpXdebugBuildStep, phpXdebugConfigEnv, phpXdebugTooling, resolvePhpXdebug } from "./php-xdebug.ts";

export {
  PHP_APT_PACKAGE_PINS,
  PHP_COMMON_EXTENSIONS,
  PHP_COMPOSER,
  PHP_COMPOSER_COMMAND,
  PHP_COMPOSER_RELEASES,
  PHP_PREREQUISITES_COMMAND,
} from "./php-prerequisites.ts";

export { PHP_FPM_LOG_SOURCES } from "./php-via.ts";

export const SUPPORTED_PHP_VERSIONS = ["8.1", "8.2", "8.3", "8.4", "8.5"] as const;
export type SupportedPhpVersion = (typeof SUPPORTED_PHP_VERSIONS)[number];

export const PHP_FEATURE_ID = "service-lando.php" as const;
export const PHP_FEATURE_PRIORITY = 600;

const APP_MOUNT_TARGET = PortablePath.make("/app");
const PhpWebroot = Schema.String.pipe(
  Schema.pattern(/^\/[A-Za-z0-9._/-]*$/u, {
    message: () =>
      "PHP webroot must be an absolute container path using only letters, digits, '.', '_', '-', and '/'.",
  }),
  Schema.brand("PhpWebroot"),
);

const PhpFeatureConfigSchema = Schema.Struct({
  allowOverride: Schema.Boolean,
  version: Schema.Literal(...SUPPORTED_PHP_VERSIONS),
  via: Schema.Literal("apache", "fpm", "cli"),
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

const applyApacheShape = (ctx: ServiceFeatureContext, webroot: string, allowOverride: boolean): void => {
  ctx.addEnv("APACHE_DOCUMENT_ROOT", webroot);
  if (ctx.normalizedConfig.image === undefined) {
    ctx.setCommand(apacheStartCommand(webroot, allowOverride));
  }
};

const applyFpmShape = (ctx: ServiceFeatureContext): void => {
  if (ctx.normalizedConfig.image === undefined && ctx.normalizedConfig.command === undefined) {
    ctx.setCommand(fpmStartCommand(phpListenPort("fpm", ctx.normalizedConfig.port)));
  }
};

const applyCliShape = (ctx: ServiceFeatureContext): void => {
  if (ctx.normalizedConfig.image === undefined && ctx.normalizedConfig.command === undefined) {
    ctx.setCommand([...PHP_CLI_KEEP_ALIVE]);
  }
};

const applyServingMode = (
  ctx: ServiceFeatureContext,
  via: PhpVia,
  webroot: string,
  allowOverride: boolean,
): void => {
  switch (via) {
    case "apache":
      applyApacheShape(ctx, webroot, allowOverride);
      return;
    case "fpm":
      applyFpmShape(ctx);
      return;
    case "cli":
      applyCliShape(ctx);
      return;
  }
};

const applyPhpFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { allowOverride, version, via, webroot } = configFor(ctx);
  const port = phpListenPort(via, service.port);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? phpImageFor(version, via) });
  const xdebug = resolvePhpXdebug(service.xdebug);
  if (service.image === undefined) {
    for (const step of phpPrerequisiteBuildSteps(service.composer)) ctx.addBuildStep(step);
    if (xdebug !== false) ctx.addBuildStep(phpXdebugBuildStep(version, xdebug));
  }
  if (xdebug !== false) {
    for (const [name, value] of Object.entries(phpXdebugConfigEnv())) {
      ctx.addEnv(name, value);
    }
  }
  ctx.setWorkingDirectory(service.workingDirectory ?? PortablePath.make(webroot));
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
  applyServingMode(ctx, via, webroot, allowOverride);
  if (via !== "cli") {
    addServicePortEndpoints(ctx, { port, protocol: phpEndpointProtocol(via) });
    ctx.setHealthcheck({
      kind: "command",
      command: ["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 10,
    });
  }

  if (service.user !== undefined) ctx.setUser(service.user);
  if (service.command !== undefined) ctx.setCommand(service.command);
  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);

  ctx.addExtension("lando-service-php", {
    allowOverride,
    webroot,
    version,
    via,
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
  schema: PhpServiceConfig,
  resolve: (input) =>
    Effect.try({
      try: () => {
        const resolvedVersion = validateVersion(input.service.type, version);
        resolvePhpComposer(input.service.composer);
        const via = resolvePhpVia(input.service.via);
        assertPhpViaKeys(via, input.service);
        const xdebug = resolvePhpXdebug(input.service.xdebug);
        resolvePhpDbClient(input.service.db_client);
        const webroot = Schema.decodeUnknownSync(PhpWebroot)(input.service.webroot ?? APP_MOUNT_TARGET);
        const allowOverride = input.service.allowOverride ?? false;

        return {
          base: "lando" as const,
          normalizedConfig: normalizedService(input.service, resolvedVersion),
          logSources: PHP_FPM_LOG_SOURCES,
          features: [
            { id: PHP_FEATURE_ID, config: { allowOverride, version: resolvedVersion, via, webroot } },
            {
              id: "lando.env",
              config: { appPaths: { appRoot: "/app", projectMount: "/app" }, webroot },
            },
          ],
          ...(xdebug === false ? {} : { tooling: phpXdebugTooling(input.name, via, xdebug.mode) }),
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
export const php85ServiceType: ServiceType = makePhpServiceType("8.5");
