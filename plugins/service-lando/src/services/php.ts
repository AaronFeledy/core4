import { Effect, Schema } from "effect";

import { ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";
import { AbsolutePath, PortablePath, type ServiceConfig } from "@lando/sdk/schema";
import { PhpServiceConfig } from "@lando/sdk/schema/services/php";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { addServicePortEndpoints } from "./_port-helpers.ts";
import { parseServiceMount } from "./_volume-helpers.ts";
import { DEBIAN_APACHE_PORTS_CONF_PATH, apacheListenBuildStep, authoredListenPort } from "./apache.ts";
import { landoErrorPagesBuildStep } from "./http-errors.ts";
import { phpComposerPackagesBuildStep, resolvePhpComposerPackages } from "./php-composer-packages.ts";
import { resolvePhpDbClient } from "./php-db-client.ts";
import {
  PHP_COMPOSER_STEP_ID,
  assertPhpComposerCompatible,
  phpPrerequisiteBuildSteps,
  resolvePhpComposer,
} from "./php-prerequisites.ts";
import {
  PHP_CLI_KEEP_ALIVE,
  type PhpVia,
  apacheDefaultSiteRemovalBuildStep,
  apacheStartCommand,
  assertPhpViaKeys,
  fpmStartCommand,
  hasCustomPhpImage,
  phpEndpointProtocol,
  phpImageFor,
  phpListenPort,
  phpLogSources,
  resolvePhpVia,
} from "./php-via.ts";
import {
  assertPhpXdebugSupported,
  phpXdebugBuildStep,
  phpXdebugConfigEnv,
  phpXdebugTooling,
  resolvePhpXdebug,
} from "./php-xdebug.ts";

export {
  PHP_APT_PACKAGE_PINS,
  PHP_COMMON_EXTENSIONS,
  PHP_COMPOSER,
  PHP_COMPOSER_COMMAND,
  PHP_COMPOSER_RELEASES,
  PHP_COMPOSER_STEP_ID,
  PHP_PREREQUISITES_COMMAND,
} from "./php-prerequisites.ts";

export { PHP_COMPOSER_PACKAGES_STEP_ID } from "./php-composer-packages.ts";

export { PHP_FPM_LOG_SOURCES } from "./php-via.ts";

export const SUPPORTED_PHP_VERSIONS = ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"] as const;
export type SupportedPhpVersion = (typeof SUPPORTED_PHP_VERSIONS)[number];
const PHP_ARTIFACTS = Object.fromEntries(
  SUPPORTED_PHP_VERSIONS.map((version) => [version, phpImageFor(version, "apache")]),
);

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

const applyApacheShape = (
  ctx: ServiceFeatureContext,
  webroot: string,
  allowOverride: boolean,
  listenPort: number | undefined,
): void => {
  ctx.addEnv("APACHE_DOCUMENT_ROOT", webroot);
  if (
    !hasCustomPhpImage(ctx.normalizedConfig) &&
    ctx.normalizedConfig.command === undefined &&
    ctx.normalizedConfig.entrypoint === undefined
  ) {
    ctx.addBuildStep(apacheDefaultSiteRemovalBuildStep());
    ctx.addBuildStep(landoErrorPagesBuildStep());
    if (listenPort !== undefined) ctx.addBuildStep(apacheListenBuildStep(DEBIAN_APACHE_PORTS_CONF_PATH));
    ctx.setCommand(
      apacheStartCommand(webroot, allowOverride, listenPort, ctx.normalizedConfig.user === undefined),
    );
  }
};

const applyFpmShape = (ctx: ServiceFeatureContext): void => {
  if (!hasCustomPhpImage(ctx.normalizedConfig) && ctx.normalizedConfig.command === undefined) {
    ctx.setCommand(
      fpmStartCommand(
        phpListenPort("fpm", authoredListenPort(ctx.normalizedConfig.port)),
        ctx.normalizedConfig.user === undefined,
      ),
    );
  }
};

const applyCliShape = (ctx: ServiceFeatureContext): void => {
  if (!hasCustomPhpImage(ctx.normalizedConfig) && ctx.normalizedConfig.command === undefined) {
    ctx.setCommand([...PHP_CLI_KEEP_ALIVE]);
  }
};

const applyServingMode = (
  ctx: ServiceFeatureContext,
  via: PhpVia,
  webroot: string,
  allowOverride: boolean,
  listenPort: number | undefined,
): void => {
  switch (via) {
    case "apache":
      applyApacheShape(ctx, webroot, allowOverride, listenPort);
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
  const listenPort = authoredListenPort(service.port);
  const port = phpListenPort(via, listenPort);
  const customImage = hasCustomPhpImage(service);
  const artifact = customImage && service.image !== undefined ? service.image : phpImageFor(version, via);

  ctx.setArtifact({ kind: "ref", ref: artifact });
  const xdebug = resolvePhpXdebug(service.xdebug);
  const composerRelease = resolvePhpComposer(service.composer);
  if (!customImage) {
    for (const step of phpPrerequisiteBuildSteps(service.composer)) ctx.addBuildStep(step);
    if (xdebug !== false) ctx.addBuildStep(phpXdebugBuildStep(version, xdebug));
  }
  const composerPackagesStep = phpComposerPackagesBuildStep(resolvePhpComposerPackages(service.composer), {
    dependsOnComposerStep: !customImage && composerRelease !== false,
    composerStepId: PHP_COMPOSER_STEP_ID,
  });
  if (composerPackagesStep !== undefined) ctx.addBuildStep(composerPackagesStep);
  if (xdebug !== false) {
    for (const [name, value] of Object.entries(phpXdebugConfigEnv())) {
      ctx.addEnv(name, value);
    }
  }
  ctx.setWorkingDirectory(service.workingDirectory ?? PortablePath.make(webroot));
  const authoredMounts = (service.mounts ?? []).map((entry) => parseServiceMount(entry, ctx.appRoot));
  if (!authoredMounts.some((mount) => mount.target === APP_MOUNT_TARGET)) {
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
  }
  for (const mount of authoredMounts) {
    ctx.addMount({
      type: mount.type,
      ...(mount.source === undefined ? {} : { source: mount.source }),
      target: PortablePath.make(mount.target),
      readOnly: mount.readOnly,
    });
  }
  applyServingMode(ctx, via, webroot, allowOverride, listenPort);
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

const makePhpServiceType = (version: SupportedPhpVersion): ServiceType => ({
  id: `php:${version}`,
  name: `php:${version}`,
  base: "lando",
  versions: SUPPORTED_PHP_VERSIONS,
  artifacts: PHP_ARTIFACTS,
  identity: { defaultUser: "root", homes: { root: "/root" } },
  schema: PhpServiceConfig,
  resolve: (input) =>
    Effect.try({
      try: () => {
        const resolvedVersion = validateVersion(input.service.type, version);
        resolvePhpComposer(input.service.composer);
        resolvePhpComposerPackages(input.service.composer);
        assertPhpComposerCompatible(resolvedVersion, input.service.composer);
        const via = resolvePhpVia(input.service.via);
        assertPhpViaKeys(via, input.service);
        const xdebug = resolvePhpXdebug(input.service.xdebug);
        assertPhpXdebugSupported(resolvedVersion, xdebug);
        resolvePhpDbClient(input.service.db_client);
        const webroot = Schema.decodeUnknownSync(PhpWebroot)(input.service.webroot ?? APP_MOUNT_TARGET);
        const allowOverride = input.service.allowOverride ?? false;

        return {
          base: "lando" as const,
          normalizedConfig: {
            ...input.service,
            type: `php:${resolvedVersion}`,
          } satisfies ServiceConfig,
          logSources: phpLogSources(via),
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
export const php86ServiceType: ServiceType = makePhpServiceType("8.6");
