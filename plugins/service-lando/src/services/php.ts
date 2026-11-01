import type { ServiceConfig } from "@lando/sdk/schema";
import { PhpServiceConfig } from "@lando/sdk/schema/services/php";
import type { ServiceType } from "@lando/sdk/services";
import { Schema } from "effect";
import { ServiceConfigIssue, rootIdentity, serviceTypeResolve } from "./_feature-helpers.ts";
import { resolveWebroot } from "./_webroot.ts";
import { resolvePhpComposerPackages } from "./php-composer-packages.ts";
import { resolvePhpDbClient } from "./php-db-client.ts";
import { PHP_FEATURE_ID } from "./php-feature.ts";
import { assertPhpComposerCompatible, resolvePhpComposer } from "./php-prerequisites.ts";
import { PHP_RUNTIME_POLICY_KEY, resolvePhpRuntimePolicy } from "./php-runtime-policy.ts";
import {
  SUPPORTED_PHP_VERSIONS,
  type SupportedPhpVersion,
  assertPhpViaKeys,
  phpImageFor,
  phpLogSources,
  resolvePhpVia,
} from "./php-via.ts";
import { assertPhpXdebugSupported, phpXdebugTooling, resolvePhpXdebug } from "./php-xdebug.ts";

export { PHP_FEATURE_ID, PHP_FEATURE_PRIORITY, phpServiceFeature } from "./php-feature.ts";
export {
  PHP_APT_PACKAGE_PINS,
  PHP_COMMON_EXTENSIONS,
  PHP_COMPOSER,
  PHP_COMPOSER_COMMAND,
  PHP_COMPOSER_RELEASES,
  PHP_COMPOSER_STEP_ID,
  PHP_PREREQUISITES_COMMAND,
  PHP_PREREQUISITES_STEP_ID,
  phpPrerequisitesBuildKeyInputs,
} from "./php-prerequisites.ts";
export { PHP_COMPOSER_PACKAGES_STEP_ID } from "./php-composer-packages.ts";
export {
  PHP_BASELINE_INI_PATH,
  PHP_BASELINE_STEP_ID,
  PHP_SECURITY_BASELINE,
  renderPhpBaselineIni,
} from "./php-baseline.ts";
export { PHP_FPM_LOG_SOURCES, SUPPORTED_PHP_VERSIONS, type SupportedPhpVersion } from "./php-via.ts";
export { PHP_LISTENER, PHP_LISTENERS } from "./php-via.ts";
export const APP_MOUNT_TARGET = "/app";
const PhpVersion = Schema.Literals(SUPPORTED_PHP_VERSIONS);
const PHP_ARTIFACTS = Object.fromEntries(
  SUPPORTED_PHP_VERSIONS.map((version) => [version, phpImageFor(version, "apache")]),
);

const validateVersion = (
  declaredType: string | undefined,
  fallback: SupportedPhpVersion,
): SupportedPhpVersion => {
  if (declaredType === undefined || !declaredType.startsWith("php:")) return fallback;
  const version = declaredType.slice("php:".length);
  if (Schema.is(PhpVersion)(version)) return version;
  throw new ServiceConfigIssue(
    ["type"],
    `Unsupported PHP version "${version}".`,
    `Set type to one of: ${SUPPORTED_PHP_VERSIONS.map((v) => `php:${v}`).join(", ")} (got php:${version}).`,
  );
};

const makePhpServiceType = (version: SupportedPhpVersion): ServiceType => ({
  id: `php:${version}`,
  name: `php:${version}`,
  base: "lando",
  versions: SUPPORTED_PHP_VERSIONS,
  artifacts: PHP_ARTIFACTS,
  // Verified /etc/passwd in php:8.3-apache-bookworm and php:8.3-fpm-bookworm (linux/amd64):
  // configs sha256:8a992dacb2cb44f327c2f353176b825f52dec230383f37131db1c6cb9dda68a5
  // and sha256:7d56462eb335f178afb9536578454ea1bc7d30136ac2153df2632b86e420dd12.
  // www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin; image User and HOME are unset.
  // /var/www is 0755 root:root, so Lando prepares the passwd home for www-data in its derived image.
  identity: { ...rootIdentity({ "www-data": "/var/www" }), preparedHomes: ["www-data"] },
  schema: PhpServiceConfig,
  resolve: (input) =>
    serviceTypeResolve(`php:${version}`, `Failed to resolve php:${version}`, () => {
      const resolvedVersion = validateVersion(input.service.type, version);
      resolvePhpComposer(input.service.composer);
      resolvePhpComposerPackages(input.service.composer);
      assertPhpComposerCompatible(resolvedVersion, input.service.composer);
      const via = resolvePhpVia(input.service.via);
      assertPhpViaKeys(via, input.service);
      const xdebug = resolvePhpXdebug(input.service.xdebug);
      assertPhpXdebugSupported(resolvedVersion, xdebug);
      resolvePhpDbClient(input.service.db_client);
      const webroot = resolveWebroot("PHP", input.service.webroot, input.service.appMount);
      const allowOverride = input.service.allowOverride ?? false;
      const policy = resolvePhpRuntimePolicy(input.service, resolvedVersion, via);
      return {
        base: "lando" as const,
        normalizedConfig: { ...input.service, type: `php:${resolvedVersion}` } satisfies ServiceConfig,
        metadata: { [PHP_RUNTIME_POLICY_KEY]: policy },
        logSources: phpLogSources(policy.logMode),
        features: [
          { id: PHP_FEATURE_ID, config: { allowOverride, version: resolvedVersion, via, webroot, policy } },
          { id: "lando.env", config: { webroot } },
          { id: "lando.app-mount", config: { target: APP_MOUNT_TARGET, workingDirectory: webroot } },
        ],
        ...(xdebug === false ? {} : { tooling: phpXdebugTooling(input.name, via, xdebug.mode) }),
      };
    }),
});

export const php81ServiceType: ServiceType = makePhpServiceType("8.1");
export const php82ServiceType: ServiceType = makePhpServiceType("8.2");
export const php83ServiceType: ServiceType = makePhpServiceType("8.3");
export const php84ServiceType: ServiceType = makePhpServiceType("8.4");
export const php85ServiceType: ServiceType = makePhpServiceType("8.5");
export const php86ServiceType: ServiceType = makePhpServiceType("8.6");
