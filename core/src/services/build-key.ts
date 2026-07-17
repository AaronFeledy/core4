import { createHash } from "node:crypto";

import { buildContextContentDigest } from "@lando/container-runtime/image-build";
import { Effect } from "effect";

import { ProviderInternalError } from "@lando/sdk/errors";
import type { ServicePlan } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";

import { CORE_VERSION } from "../version.ts";

interface StableBuildInput {
  readonly landoVersion: string;
  readonly provider: {
    readonly id: string;
    readonly version: string;
    readonly platform: string;
  };
  readonly service: {
    readonly name: string;
    readonly type: string;
    readonly artifact: unknown;
    readonly command: unknown;
    readonly entrypoint: unknown;
    readonly environment: ReadonlyArray<readonly [string, unknown]>;
    readonly user: string | undefined;
    readonly workingDirectory: string | undefined;
    readonly appMount: unknown;
    readonly mounts: ReadonlyArray<unknown>;
    readonly buildSteps: ReadonlyArray<unknown>;
  };
}

interface StableArtifactBuildInput {
  readonly artifact: unknown;
  readonly contentDigest: string | undefined;
}

const SECRET_REFERENCE_PATTERN = /^\$\{secret:([^}]+)\}$/u;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stableValue = (value: unknown): unknown => {
  if (typeof value === "string") return secretAwareString(value);
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
};

const stableHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");

const secretAwareString = (value: string): unknown => {
  const match = SECRET_REFERENCE_PATTERN.exec(value);
  return match === null ? value : { secret: match[1] };
};

const stableStringRecord = (
  record: Readonly<Record<string, string>>,
): ReadonlyArray<readonly [string, unknown]> =>
  Object.entries(record)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, secretAwareString(value)] as const);

const isGeneratedLandoEnv = (key: string): boolean => key === "LANDO" || key.startsWith("LANDO_");

const providerEnvironment = (
  environment: Readonly<Record<string, string>>,
): ReadonlyArray<readonly [string, unknown]> => {
  const declared = Object.fromEntries(
    Object.entries(environment).filter(([key]) => !isGeneratedLandoEnv(key)),
  );
  return stableStringRecord(declared);
};

const artifactBuildInput = (
  artifact: ServicePlan["artifact"],
  contentDigest: string | undefined,
): unknown => {
  if (artifact?.kind === "ref") return { kind: artifact.kind, ref: artifact.ref, digest: artifact.digest };
  if (artifact?.kind !== "build") return artifact;
  return {
    kind: artifact.kind,
    spec: artifact.spec,
    args: artifact.args === undefined ? undefined : stableStringRecord(artifact.args),
    target: artifact.target,
    contentDigest,
  };
};

const stableArtifactBuildInput = (
  service: ServicePlan,
  provider: RuntimeProviderShape,
): Effect.Effect<StableArtifactBuildInput, ProviderInternalError> => {
  const artifact = service.artifact;
  if (artifact?.kind !== "build") {
    return Effect.succeed({ artifact: artifactBuildInput(artifact, undefined), contentDigest: undefined });
  }
  return Effect.tryPromise({
    try: () => buildContextContentDigest(artifact.context),
    catch: (cause) =>
      new ProviderInternalError({
        providerId: provider.id,
        operation: "buildKeyForService",
        message: "Unable to hash the artifact build context.",
        cause,
      }),
  }).pipe(
    Effect.map((contentDigest) => ({ artifact: artifactBuildInput(artifact, contentDigest), contentDigest })),
  );
};

const mountBuildInput = (mount: ServicePlan["mounts"][number]): unknown => ({
  type: mount.type,
  target: mount.target,
  readOnly: mount.readOnly,
  realization: mount.realization,
});

export const buildStepsFor = (service: ServicePlan): ReadonlyArray<unknown> => {
  const extension = service.extensions["@lando/core/service-features"];
  if (!isRecord(extension)) return [];
  const buildSteps = extension.buildSteps;
  return Array.isArray(buildSteps) ? buildSteps.map(stableValue) : [];
};

export const artifactBuildStepsFor = (service: ServicePlan): ReadonlyArray<unknown> =>
  buildStepsFor(service).filter((step) => !isRecord(step) || step.phase !== "app");

const stableBuildInput = (
  provider: RuntimeProviderShape,
  service: ServicePlan,
): Effect.Effect<StableBuildInput, ProviderInternalError> =>
  stableArtifactBuildInput(service, provider).pipe(
    Effect.map(({ artifact }) => ({
      landoVersion: CORE_VERSION,
      provider: { id: provider.id, version: provider.version, platform: provider.platform },
      service: {
        name: String(service.name),
        type: service.type,
        artifact,
        command: service.command,
        entrypoint: service.entrypoint,
        environment: providerEnvironment(service.environment),
        user: service.user,
        workingDirectory:
          service.workingDirectory === undefined ? undefined : String(service.workingDirectory),
        appMount:
          service.appMount === undefined
            ? undefined
            : {
                target: service.appMount.target,
                readOnly: service.appMount.readOnly,
                excludes: service.appMount.excludes,
                includes: service.appMount.includes,
                realization: service.appMount.realization,
              },
        mounts: service.mounts.map(mountBuildInput),
        buildSteps: artifactBuildStepsFor(service),
      },
    })),
  );

export const buildKeyForService = (
  provider: RuntimeProviderShape,
  service: ServicePlan,
): Effect.Effect<string, ProviderInternalError> =>
  stableBuildInput(provider, service).pipe(Effect.map(stableHash));
