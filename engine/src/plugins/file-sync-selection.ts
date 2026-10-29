import { FileSyncSelectionError } from "@lando/sdk/errors";
import {
  type FileSyncEngineCapabilities,
  type FileSyncEngineDescriptor,
  type HostPlatform,
  hostPlatformFamily,
} from "@lando/sdk/schema";
import { Result } from "effect";

export type FileSyncBindMountPerformance = "native" | "slow";

export interface FileSyncCandidateDefinition {
  readonly id: string;
  readonly pluginName: string;
  readonly source: string;
  readonly capabilities: FileSyncEngineCapabilities;
  readonly supports: FileSyncEngineDescriptor["supports"];
  readonly defaultFor?: FileSyncEngineDescriptor["defaultFor"];
  readonly module?: string | undefined;
}

export interface FileSyncSelectionPolicy {
  readonly platform: HostPlatform;
  readonly bindMountPerformance: FileSyncBindMountPerformance;
  readonly defaultEngine?: string | undefined;
  readonly fileSyncTargets?: "prepared-volume" | undefined;
}

export const matchesDefaultFor = (
  defaultFor: FileSyncEngineDescriptor["defaultFor"] | undefined,
  policy: FileSyncSelectionPolicy,
): boolean => {
  if (defaultFor === undefined) return false;
  const platforms = defaultFor.platform;
  const binds = defaultFor.bindMountPerformance;
  const hasPlatform = platforms !== undefined && platforms.length > 0;
  const hasBind = binds !== undefined && binds.length > 0;
  if (!hasPlatform && !hasBind) return false;
  if (hasPlatform && !platforms.includes(hostPlatformFamily(policy.platform))) return false;
  if (hasBind && !binds.includes(policy.bindMountPerformance)) return false;
  return true;
};

const isEligible = (candidate: FileSyncCandidateDefinition, policy: FileSyncSelectionPolicy): boolean =>
  candidate.supports.platform.includes(hostPlatformFamily(policy.platform)) &&
  policy.fileSyncTargets === "prepared-volume" &&
  candidate.capabilities.modes.includes("two-way-safe") &&
  candidate.capabilities.exclusionPatterns;

const requireMode = <C extends FileSyncCandidateDefinition>(
  candidate: C,
  candidates: ReadonlyArray<string>,
  policy: FileSyncSelectionPolicy,
): Result.Result<C, FileSyncSelectionError> =>
  isEligible(candidate, policy)
    ? Result.succeed(candidate)
    : Result.fail(
        new FileSyncSelectionError({
          reason: "capabilities",
          engineId: candidate.id,
          candidates,
          message: `File-sync engine ${candidate.id} does not support this host, provider target lifecycle, or required two-way-safe exclusion filtering.`,
          remediation:
            "Choose a file-sync engine that supports two-way-safe, or set defaultFileSyncEngine to passthrough.",
        }),
      );

export const selectFileSyncCandidate = <C extends FileSyncCandidateDefinition>(
  candidates: ReadonlyArray<C>,
  policy: FileSyncSelectionPolicy,
): Result.Result<C | undefined, FileSyncSelectionError> => {
  if (
    policy.defaultEngine === "passthrough" ||
    (policy.bindMountPerformance === "native" && policy.defaultEngine === undefined)
  )
    return Result.succeed(undefined);

  const sortedIds = candidates.map(({ id }) => id).sort();
  const duplicateId = sortedIds.find((id, index) => index > 0 && sortedIds[index - 1] === id);
  if (duplicateId !== undefined) {
    return Result.fail(
      new FileSyncSelectionError({
        reason: "duplicate",
        engineId: duplicateId,
        candidates: sortedIds,
        message: `File-sync engine id ${duplicateId} is contributed more than once.`,
        remediation: `Disable or rename duplicate file-sync engine contributions for ${duplicateId}.`,
      }),
    );
  }
  if (policy.defaultEngine !== undefined) {
    const match = candidates.find(({ id }) => id === policy.defaultEngine);
    if (match === undefined) {
      return Result.fail(
        new FileSyncSelectionError({
          reason: "unknown",
          engineId: policy.defaultEngine,
          candidates: sortedIds,
          message: `Configured file-sync engine ${policy.defaultEngine} is not installed.`,
          remediation: `Install or enable file-sync engine ${policy.defaultEngine}, or clear defaultFileSyncEngine.`,
        }),
      );
    }
    const supported = requireMode(match, sortedIds, policy);
    return policy.bindMountPerformance === "native" && Result.isSuccess(supported)
      ? Result.succeed(undefined)
      : supported;
  }

  const eligible = candidates.filter((candidate) => isEligible(candidate, policy));
  const defaults = eligible.filter(({ defaultFor }) => matchesDefaultFor(defaultFor, policy));
  if (defaults.length > 1) {
    return Result.fail(
      new FileSyncSelectionError({
        reason: "ambiguous-default",
        candidates: defaults.map(({ id }) => id).sort(),
        message: "Multiple file-sync engines declare a matching defaultFor.",
        remediation:
          "Disable all but one matching default file-sync engine, or set defaultFileSyncEngine explicitly.",
      }),
    );
  }
  const [soleDefault] = defaults;
  if (soleDefault !== undefined) return Result.succeed(soleDefault);
  const [sole, second] = eligible;
  if (sole === undefined) {
    return Result.succeed(undefined);
  }
  if (second === undefined) return Result.succeed(sole);
  return Result.fail(
    new FileSyncSelectionError({
      reason: "ambiguous",
      candidates: eligible.map(({ id }) => id).sort(),
      message: "Multiple file-sync engines are available and none is the unique default.",
      remediation: "Set defaultFileSyncEngine, or disable all but one file-sync engine plugin.",
    }),
  );
};
