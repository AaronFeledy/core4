import { basename } from "node:path";

import { Schema } from "effect";

import { AbsolutePath, PortablePath, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ServiceTypePlanInput, ServiceTypeShape } from "@lando/sdk/services";

export const SUPPORTED_PHP_VERSIONS = ["8.2", "8.3"] as const;
export type SupportedPhpVersion = (typeof SUPPORTED_PHP_VERSIONS)[number];

export const SUPPORTED_PHP_FRAMEWORKS = ["drupal", "wordpress", "laravel", "symfony", "none"] as const;
export type SupportedPhpFramework = (typeof SUPPORTED_PHP_FRAMEWORKS)[number];

const APP_MOUNT_TARGET = PortablePath.make("/app");
const HEALTHCHECK_PORT = 80;

const FRAMEWORK_WEBROOTS: Record<SupportedPhpFramework, string> = {
  drupal: "web",
  wordpress: "",
  laravel: "public",
  symfony: "public",
  none: "",
};

const FRAMEWORK_ENV: Record<SupportedPhpFramework, ReadonlyMap<string, string>> = {
  drupal: new Map([
    ["APACHE_DOCUMENT_ROOT", "/app/web"],
    ["LANDO_WEBROOT", "/app/web"],
  ]),
  wordpress: new Map([
    ["APACHE_DOCUMENT_ROOT", "/app"],
    ["LANDO_WEBROOT", "/app"],
  ]),
  laravel: new Map([
    ["APACHE_DOCUMENT_ROOT", "/app/public"],
    ["LANDO_WEBROOT", "/app/public"],
  ]),
  symfony: new Map([
    ["APACHE_DOCUMENT_ROOT", "/app/public"],
    ["LANDO_WEBROOT", "/app/public"],
  ]),
  none: new Map([
    ["APACHE_DOCUMENT_ROOT", "/app"],
    ["LANDO_WEBROOT", "/app"],
  ]),
};

const REMEDIATION_VERSION = (requested: string): string =>
  `Set type to one of: ${SUPPORTED_PHP_VERSIONS.map((v) => `php:${v}`).join(", ")} (got php:${requested}).`;

const REMEDIATION_FRAMEWORK = (requested: string): string =>
  `Set framework to one of: ${SUPPORTED_PHP_FRAMEWORKS.join(", ")} (got ${requested}).`;

const slug = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const appNameFor = (input: ServiceTypePlanInput): string => {
  if (input.appName !== undefined && input.appName.length > 0) return input.appName;
  return basename(input.appRoot) || "app";
};

const workingDirectoryFor = (framework: SupportedPhpFramework): string => {
  const webroot = FRAMEWORK_WEBROOTS[framework];
  return webroot === "" ? "/app" : `/app/${webroot}`;
};

const buildEnv = (
  appName: string,
  serviceName: string,
  serviceType: string,
  framework: SupportedPhpFramework,
  userEnv: Record<string, string>,
): Record<string, string> => {
  const env: Record<string, string> = {
    LANDO: "ON",
    LANDO_APP_NAME: appName,
    LANDO_APP_KIND: "user",
    LANDO_APP_ROOT: "/app",
    LANDO_PROJECT: slug(appName),
    LANDO_PROJECT_MOUNT: "/app",
    LANDO_SERVICE_API: "4",
    LANDO_SERVICE_NAME: serviceName,
    LANDO_SERVICE_TYPE: serviceType,
  };
  for (const [key, value] of FRAMEWORK_ENV[framework]) {
    env[key] = value;
  }
  for (const [key, value] of Object.entries(userEnv)) {
    env[key] = value;
  }
  return env;
};

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

const makePhpServiceType = (version: SupportedPhpVersion): ServiceTypeShape => ({
  id: `php:${version}`,
  toServicePlan: (input) => {
    const { name, service, appRoot, provider = ProviderId.make("lando"), primary, metadata } = input;
    const resolvedVersion = validateVersion(service.type, version);
    const framework = validateFramework(service.framework);
    const appName = appNameFor(input);
    const serviceType = `php:${resolvedVersion}`;
    const workingDirectory = service.workingDirectory ?? PortablePath.make(workingDirectoryFor(framework));
    const environment = buildEnv(appName, name, serviceType, framework, service.environment ?? {});
    const endpointPort = service.port ?? HEALTHCHECK_PORT;

    return Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: serviceType,
      provider,
      primary: service.primary ?? primary ?? name === "web",
      artifact: { kind: "ref", ref: service.image ?? `php:${resolvedVersion}-apache` },
      command: service.command,
      entrypoint: service.entrypoint,
      environment,
      user: service.user,
      workingDirectory,
      appMount: {
        source: AbsolutePath.make(appRoot),
        target: APP_MOUNT_TARGET,
        readOnly: false,
        excludes: [],
        includes: [],
        realization: "passthrough",
      },
      mounts: [
        {
          type: "bind",
          source: appRoot,
          target: APP_MOUNT_TARGET,
          readOnly: false,
          realization: "passthrough",
        },
      ],
      storage: [],
      endpoints: [{ port: endpointPort, protocol: "http", name }],
      routes: [],
      dependsOn: (service.dependsOn ?? []).map((dependency) => ({
        service: ServiceName.make(dependency),
        condition: "started",
      })),
      healthcheck: {
        kind: "tcp",
        port: endpointPort,
        intervalSeconds: 10,
        timeoutSeconds: 5,
        retries: 5,
        startPeriodSeconds: 10,
      },
      hostAliases: [],
      metadata,
      extensions: {
        "lando-service-php": {
          framework,
          webroot: FRAMEWORK_WEBROOTS[framework] === "" ? "/app" : `/app/${FRAMEWORK_WEBROOTS[framework]}`,
          version: resolvedVersion,
        },
      },
    });
  },
});

export const php82ServiceType: ServiceTypeShape = makePhpServiceType("8.2");
export const php83ServiceType: ServiceTypeShape = makePhpServiceType("8.3");
