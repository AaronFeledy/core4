/** Service-type resolution contracts and boundary helpers. */
import { createHash } from "node:crypto";
import * as os from "node:os";
import { resolve } from "node:path";

import { type Context, Effect } from "effect";

import {
  LandofileValidationError,
  type PluginLoadError,
  type PluginManifestError,
  ServiceTypeCollisionError,
} from "@lando/sdk/errors";
import type { LogSource, RouteInput, ServiceConfig, ServicePlan, StorageScope } from "@lando/sdk/schema";
import type {
  FileSystem,
  PluginRegistry,
  ServiceType,
  ServiceTypeHostFacts,
  ServiceTypeResolution,
} from "@lando/sdk/services";

import { parseEnvFile } from "@lando/landofile/env-file";
import type { AppFeatureServiceDraft } from "../services/app-feature.ts";
import { L337_BASE_DEFAULT_FEATURE_IDS } from "../services/base/l337.ts";
import { LANDO_BASE_DEFAULT_FEATURE_IDS } from "../services/base/lando.ts";

export type ContributionRef = string | { readonly id: string };

export const contributionId = (entry: ContributionRef): string =>
  typeof entry === "string" ? entry : entry.id;

const imageIs = (image: string | undefined, name: string): boolean =>
  image === name || image?.startsWith(`${name}:`) === true;

export const serviceTypeFor = (name: string, service: ServiceConfig): string => {
  if (service.type !== undefined) return service.type;
  const image = service.image;
  if (image?.startsWith("node:22")) return "node:22";
  if (image?.startsWith("node:")) return "node:lts";
  if (imageIs(image, "postgres")) return "postgres";
  if (imageIs(image, "mysql")) return "mysql";
  if (imageIs(image, "mariadb")) return "mariadb";
  if (imageIs(image, "redis")) return "redis";
  if (imageIs(image, "nginx")) return "nginx";
  if (imageIs(image, "httpd")) return "apache";
  if (image?.startsWith("php:8.2")) return "php:8.2";
  if (image?.startsWith("php:8.3")) return "php:8.3";
  if (image?.startsWith("python:3.12")) return "python:3.12";
  if (image?.startsWith("ruby:3.3")) return "ruby:3.3";
  if (image?.startsWith("golang:1.22")) return "go:1.22";
  if (image?.startsWith("golang:1.23")) return "go:1.23";
  return name;
};

interface LoadedServiceType {
  readonly serviceType: ServiceType;
  readonly version: string | undefined;
}

export const loadServiceTypeWithVersion = (
  pluginRegistry: Context.Tag.Service<typeof PluginRegistry>,
  reference: string,
): Effect.Effect<LoadedServiceType, PluginLoadError | PluginManifestError | ServiceTypeCollisionError> =>
  pluginRegistry.loadServiceType(reference).pipe(
    Effect.map((serviceType) => ({ serviceType, version: undefined as string | undefined })),
    Effect.catchAll((error) => {
      if (error instanceof ServiceTypeCollisionError) return Effect.fail(error);
      const lastColon = reference.lastIndexOf(":");
      if (lastColon <= 0) return Effect.fail(error);
      const typeName = reference.slice(0, lastColon);
      const version = reference.slice(lastColon + 1);
      if (version.length === 0) return Effect.fail(error);
      return pluginRegistry
        .loadServiceType(typeName)
        .pipe(Effect.map((serviceType) => ({ serviceType, version: version as string | undefined })));
    }),
  );

export const resolvePinnedArtifactTag = (
  appRoot: string,
  serviceName: string,
  serviceType: ServiceType,
  version: string | undefined,
): Effect.Effect<string | undefined, LandofileValidationError> => {
  if (version === undefined) return Effect.succeed(undefined);
  const pinned = serviceType.artifacts?.[version];
  if (pinned !== undefined) return Effect.succeed(pinned);
  const declaredVersions = serviceType.versions;
  if (declaredVersions !== undefined && declaredVersions.length > 0 && !declaredVersions.includes(version)) {
    return Effect.fail(
      new LandofileValidationError({
        message: `Service ${serviceName} requests unsupported version ${version} of service type ${serviceType.id}. Supported versions: ${[...declaredVersions].sort().join(", ")}.`,
        file: `${appRoot}/.lando.yml`,
        issues: [`services.${serviceName}.type`],
      }),
    );
  }
  return Effect.succeed(`${serviceType.id}:${version}`);
};

export const unsupportedServiceType = (
  appRoot: string,
  serviceName: string,
  serviceType: string,
  registeredTypeIds: ReadonlyArray<string>,
) => {
  const colonIdx = serviceType.indexOf(":");
  const prefix = colonIdx > 0 ? serviceType.slice(0, colonIdx + 1) : null;
  const familyMatches = prefix === null ? [] : registeredTypeIds.filter((id) => id.startsWith(prefix)).sort();
  let remediation = "";
  if (familyMatches.length > 0) {
    remediation = ` Supported alternatives: ${familyMatches.join(", ")}.`;
  } else if (registeredTypeIds.length > 0) {
    remediation = ` Registered service types: ${[...registeredTypeIds].sort().join(", ")}.`;
  }
  return new LandofileValidationError({
    message: `Unsupported service type ${serviceType} for service ${serviceName}.${remediation}`,
    file: `${appRoot}/.lando.yml`,
    issues: [`services.${serviceName}.type`],
  });
};

export const serviceTypeCollision = (
  appRoot: string,
  serviceName: string,
  error: ServiceTypeCollisionError,
): LandofileValidationError =>
  new LandofileValidationError({
    message: error.remediation === undefined ? error.message : `${error.message} ${error.remediation}`,
    file: `${appRoot}/.lando.yml`,
    issues: [`services.${serviceName}.type`],
  });

export const servicePlanError = (appRoot: string, serviceName: string, cause: unknown) =>
  new LandofileValidationError({
    message: cause instanceof Error ? cause.message : `Invalid service ${serviceName}.`,
    file: `${appRoot}/.lando.yml`,
    issues: [`services.${serviceName}`],
  });

export const appFeatureError = (appRoot: string, cause: unknown) =>
  new LandofileValidationError({
    message: cause instanceof Error ? cause.message : "Invalid app-feature composition.",
    file: `${appRoot}/.lando.yml`,
    issues: ["appFeatures"],
  });

export interface ResolvedService {
  readonly name: string;
  readonly service: ServiceConfig;
  readonly authored: {
    readonly byStore: Map<string, AuthoredStorageInfo>;
    readonly globalEntry?: { readonly index: number; readonly store?: string };
    readonly invalidCacheEntry?: LandofileValidationError;
  };
  readonly serviceType: ServiceType;
  readonly resolution: ServiceTypeResolution;
  readonly logSources: ReadonlyArray<LogSource>;
  readonly baseDefaultIds: ReadonlyArray<string>;
  readonly featureRefs: ReadonlyArray<{
    readonly id: string;
    readonly config?: Readonly<Record<string, unknown>>;
  }>;
  readonly resolvedArtifactTag: string | undefined;
  readonly envFileInputs: ReadonlyArray<{ readonly source: string; readonly hash: string }>;
}

export type AuthoredStorageInfo = {
  readonly scope: StorageScope;
  readonly kind: "data" | "cache";
  readonly key?: string;
};

export type PlannedServiceDraft = {
  readonly name: string;
  readonly hostnames: ReadonlyArray<string>;
  readonly authoredArtifact: ServicePlan["artifact"];
  readonly authored: ResolvedService["authored"];
  readonly draft: AppFeatureServiceDraft;
  readonly logSources: ReadonlyArray<LogSource>;
  readonly routes: ReadonlyArray<RouteInput>;
  readonly extensions: ServicePlan["extensions"];
};

export const loadServiceEnvFiles = (input: {
  readonly appRoot: string;
  readonly serviceName: string;
  readonly service: ServiceConfig;
  readonly fileSystem: Context.Tag.Service<typeof FileSystem> | undefined;
}): Effect.Effect<
  {
    readonly environment: Readonly<Record<string, string>> | undefined;
    readonly inputs: ReadonlyArray<{ readonly source: string; readonly hash: string }>;
  },
  LandofileValidationError
> =>
  Effect.gen(function* () {
    const envFiles = input.service.envFile ?? [];
    if (envFiles.length === 0) return { environment: input.service.environment, inputs: [] };
    if (input.fileSystem === undefined) {
      return yield* Effect.fail(
        new LandofileValidationError({
          message: `Service ${input.serviceName} declares env_file, but the FileSystem service is unavailable. Provide FileSystem so env files can be read.`,
          file: `${input.appRoot}/.lando.yml`,
          issues: [`services.${input.serviceName}.envFile`],
        }),
      );
    }

    const environment: Record<string, string> = {};
    const inputs: Array<{ readonly source: string; readonly hash: string }> = [];
    for (const [index, authoredPath] of envFiles.entries()) {
      const source = resolve(input.appRoot, authoredPath);
      const content = yield* input.fileSystem.readText(source).pipe(
        Effect.mapError(
          (cause) =>
            new LandofileValidationError({
              message: `Unable to read env file ${source} for service ${input.serviceName}: ${cause.message}. Create a readable env file at that path or remove it from env_file.`,
              file: source,
              issues: [`services.${input.serviceName}.envFile[${index}]`],
            }),
        ),
      );
      const parsed = parseEnvFile(content, source);
      if (!parsed.ok) {
        return yield* Effect.fail(
          new LandofileValidationError({
            message: `Invalid env file entry at ${parsed.issue.source}:${parsed.issue.line}: ${parsed.issue.message} Use KEY=VALUE entries, optionally prefixed with export.`,
            file: parsed.issue.source,
            issues: [`line ${parsed.issue.line}`],
          }),
        );
      }
      Object.assign(environment, parsed.environment);
      inputs.push({ source, hash: createHash("sha256").update(content).digest("hex") });
    }
    return { environment: { ...environment, ...(input.service.environment ?? {}) }, inputs };
  });

export const baseDefaultFeatureIds = (base: ServiceTypeResolution["base"]): ReadonlyArray<string> =>
  base === "lando" ? LANDO_BASE_DEFAULT_FEATURE_IDS : L337_BASE_DEFAULT_FEATURE_IDS;

export const resolveHostFacts = (): ServiceTypeHostFacts | undefined => {
  try {
    const userInfo = os.userInfo();
    return {
      os: process.platform,
      user: userInfo.username,
      uid: String(userInfo.uid),
      gid: String(userInfo.gid),
      home: userInfo.homedir,
    };
  } catch {
    return undefined;
  }
};
