import { Schema } from "effect";

import { AbsolutePath, PortablePath, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { appNameFor, buildLandoEnv } from "./env.ts";

export const SUPPORTED_PHP_VERSIONS = ["8.2", "8.3"] as const;
export type SupportedPhpVersion = (typeof SUPPORTED_PHP_VERSIONS)[number];

export const SUPPORTED_PHP_FRAMEWORKS = ["drupal", "wordpress", "laravel", "symfony", "none"] as const;
export type SupportedPhpFramework = (typeof SUPPORTED_PHP_FRAMEWORKS)[number];

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

const makePhpServiceType = (version: SupportedPhpVersion): ServiceTypeShape => ({
  id: `php:${version}`,
  toServicePlan: (input) => {
    const { name, service, appRoot, provider = ProviderId.make("lando"), primary, metadata, host } = input;
    const resolvedVersion = validateVersion(service.type, version);
    const framework = validateFramework(service.framework);
    const appName = appNameFor(input);
    const serviceType = `php:${resolvedVersion}`;
    const webroot = frameworkWebrootPath(framework);
    const workingDirectory = service.workingDirectory ?? PortablePath.make(webroot);
    const environment = buildLandoEnv({
      serviceName: name,
      serviceType,
      appName,
      appPaths: { appRoot: "/app", projectMount: "/app" },
      webroot,
      host,
      extraDefaults: { APACHE_DOCUMENT_ROOT: webroot },
      userEnv: service.environment ?? {},
    });
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
        kind: "command",
        command: ["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${endpointPort}`],
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
          webroot: frameworkWebrootPath(framework),
          version: resolvedVersion,
        },
      },
    });
  },
});

export const php82ServiceType: ServiceTypeShape = makePhpServiceType("8.2");
export const php83ServiceType: ServiceTypeShape = makePhpServiceType("8.3");
