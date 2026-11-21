import { engineInfoRootless } from "../capabilities.ts";
import { type PodmanVersionNumbers, parsePodmanVersionNumbers } from "./version-floor.ts";

/**
 * First crun release that fails every exec under rootless Podman run by the
 * systemd user manager (https://github.com/containers/crun/issues/2466).
 */
export const CRUN_OOM_SCORE_ADJ_BROKEN_AT = "1.31";

/**
 * Last Podman release known not to include the exec oom_score_adj clamp.
 * Newer patch releases may still lack it; do not treat this as a retirement
 * bound.
 */
export const PODMAN_EXEC_CLAMP_AFTER = "6.2.0";

/**
 * First Podman release known to include the exec oom_score_adj clamp.
 * Leave undefined until such a release exists; the clamp is merged but
 * unreleased, so a 6.2.x without it must still warn.
 */
export const PODMAN_EXEC_CLAMP_VERSION: string | undefined = undefined;

/**
 * First crun release known to actually fix containers/crun#2466.
 * Leave undefined until such a release exists; a crun-side fix may never land
 * (https://github.com/containers/crun/issues/2467).
 */
export const CRUN_OOM_SCORE_ADJ_FIXED_VERSION: string | undefined = undefined;

export const CRUN_OOM_SCORE_ADJ_ISSUE_URL = "https://github.com/containers/crun/issues/2466";

export const CRUN_OOM_SCORE_ADJ_SUBSTRING = "oom_score_adj";

export const ATTACH_CONNECTION_RESET_SUBSTRING = "connection reset by peer";

export interface KnownBadOciRuntime {
  readonly name: string;
  /** Inclusive lower bound of the broken OCI runtime range. */
  readonly versionAtLeast: string;
  /**
   * Inclusive upper bound of affected Podman releases. Undefined means every
   * Podman release is still in the warning window until
   * `podmanExecClampVersion` is recorded.
   */
  readonly affectedPodmanAtMost: string | undefined;
  /**
   * First Podman release known to include the exec clamp. Undefined means that
   * retirement path is not yet known.
   */
  readonly podmanExecClampVersion: string | undefined;
  /**
   * First OCI runtime release known to fix the bug. Undefined means that
   * retirement path is not yet known.
   */
  readonly fixedRuntimeVersion: string | undefined;
  readonly issueUrl: string;
}

export const KNOWN_BAD_CRUN: KnownBadOciRuntime = {
  name: "crun",
  versionAtLeast: CRUN_OOM_SCORE_ADJ_BROKEN_AT,
  affectedPodmanAtMost: undefined,
  podmanExecClampVersion: PODMAN_EXEC_CLAMP_VERSION,
  fixedRuntimeVersion: CRUN_OOM_SCORE_ADJ_FIXED_VERSION,
  issueUrl: CRUN_OOM_SCORE_ADJ_ISSUE_URL,
};

const VERSION_NUMBERS_PATTERN = /(\d+)\.(\d+)(?:\.(\d+))?/u;

export const parseRuntimeVersionNumbers = (version: string): PodmanVersionNumbers | undefined => {
  const match = VERSION_NUMBERS_PATTERN.exec(version);
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
  };
};

const compareVersionNumbers = (left: PodmanVersionNumbers, right: PodmanVersionNumbers): number => {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
};

const compareParsedVersions = (observed: string, bound: string): number | undefined => {
  const observedNumbers = parseRuntimeVersionNumbers(observed) ?? parsePodmanVersionNumbers(observed);
  const boundNumbers = parseRuntimeVersionNumbers(bound) ?? parsePodmanVersionNumbers(bound);
  if (observedNumbers === undefined || boundNumbers === undefined) return undefined;
  return compareVersionNumbers(observedNumbers, boundNumbers);
};

export const versionAtLeast = (observed: string, floor: string): boolean => {
  const comparison = compareParsedVersions(observed, floor);
  return comparison !== undefined && comparison >= 0;
};

export const versionAtMost = (observed: string, ceiling: string): boolean => {
  const comparison = compareParsedVersions(observed, ceiling);
  return comparison !== undefined && comparison <= 0;
};

export const versionGreaterThan = (observed: string, bound: string): boolean => {
  const comparison = compareParsedVersions(observed, bound);
  return comparison !== undefined && comparison > 0;
};

export interface OciRuntimeBanner {
  readonly name: string;
  readonly version: string;
}

const formatBannerVersion = (numbers: PodmanVersionNumbers, rest: string): string => {
  const threePart = `${numbers.major}.${numbers.minor}.${numbers.patch}`;
  if (rest.startsWith(threePart)) return threePart;
  const twoPart = `${numbers.major}.${numbers.minor}`;
  if (rest.startsWith(twoPart)) return numbers.patch === 0 ? twoPart : threePart;
  return threePart;
};

/**
 * Parse `host.ociRuntime.version` as a multi-line banner whose first line is
 * `<name> version <semver>`, not a bare semver string.
 */
export const parseOciRuntimeBanner = (name: string, banner: string): OciRuntimeBanner | undefined => {
  const firstLine = banner.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return undefined;
  const prefix = `${name} version `;
  if (!firstLine.startsWith(prefix)) return undefined;
  const rest = firstLine.slice(prefix.length).trim();
  const numbers = parseRuntimeVersionNumbers(rest);
  if (numbers === undefined) return undefined;
  return { name, version: formatBannerVersion(numbers, rest) };
};

export interface LibpodOciRuntime {
  readonly name: string;
  readonly versionBanner: string;
}

export const readLibpodOciRuntime = (info: unknown): LibpodOciRuntime | undefined => {
  if (typeof info !== "object" || info === null) return undefined;
  const host = "host" in info ? info.host : undefined;
  if (typeof host !== "object" || host === null) return undefined;
  const ociRuntime = "ociRuntime" in host ? host.ociRuntime : undefined;
  if (typeof ociRuntime !== "object" || ociRuntime === null) return undefined;
  const name = "name" in ociRuntime ? ociRuntime.name : undefined;
  const version = "version" in ociRuntime ? ociRuntime.version : undefined;
  if (typeof name !== "string" || name.length === 0) return undefined;
  if (typeof version !== "string" || version.length === 0) return undefined;
  return { name, versionBanner: version };
};

export const readLibpodServerVersion = (info: unknown): string | undefined => {
  if (typeof info !== "object" || info === null) return undefined;
  const version = "version" in info ? info.version : undefined;
  if (typeof version !== "object" || version === null || !("Version" in version)) return undefined;
  const serverVersion = version.Version;
  return typeof serverVersion === "string" && serverVersion.length > 0 ? serverVersion : undefined;
};

export interface CrunExecCompatibilityWarning {
  readonly runtimeName: string;
  readonly runtimeVersion: string;
  readonly podmanVersion: string;
  readonly issueUrl: string;
  readonly message: string;
  readonly remediation: string;
}

export const CRUN_OOM_SCORE_ADJ_REMEDIATION =
  "Downgrade or pin the host crun package below 1.31, or run `lando setup` to switch to the managed provider.";

export const crunExecCompatibilityMessage = (input: {
  readonly runtimeVersion: string;
  readonly podmanVersion: string;
  readonly issueUrl: string;
}): string =>
  `Rootless system Podman ${input.podmanVersion} with crun ${input.runtimeVersion} cannot exec (${input.issueUrl}). ${CRUN_OOM_SCORE_ADJ_REMEDIATION}`;

export const evaluateKnownBadOciRuntime = (
  input: {
    readonly runtimeName: string | undefined;
    readonly runtimeVersionBanner: string | undefined;
    readonly podmanVersion: string | undefined;
    readonly rootless: boolean | undefined;
  },
  entry: KnownBadOciRuntime = KNOWN_BAD_CRUN,
): CrunExecCompatibilityWarning | undefined => {
  if (input.rootless !== true) return undefined;
  if (input.runtimeName !== entry.name) return undefined;
  if (input.runtimeVersionBanner === undefined || input.podmanVersion === undefined) return undefined;
  const parsed = parseOciRuntimeBanner(entry.name, input.runtimeVersionBanner);
  if (parsed === undefined) return undefined;

  if (entry.fixedRuntimeVersion !== undefined && versionAtLeast(parsed.version, entry.fixedRuntimeVersion)) {
    return undefined;
  }
  if (
    entry.podmanExecClampVersion !== undefined &&
    versionAtLeast(input.podmanVersion, entry.podmanExecClampVersion)
  ) {
    return undefined;
  }
  if (!versionAtLeast(parsed.version, entry.versionAtLeast)) return undefined;
  if (
    entry.affectedPodmanAtMost !== undefined &&
    !versionAtMost(input.podmanVersion, entry.affectedPodmanAtMost)
  ) {
    return undefined;
  }

  return {
    runtimeName: parsed.name,
    runtimeVersion: parsed.version,
    podmanVersion: input.podmanVersion,
    issueUrl: entry.issueUrl,
    message: crunExecCompatibilityMessage({
      runtimeVersion: parsed.version,
      podmanVersion: input.podmanVersion,
      issueUrl: entry.issueUrl,
    }),
    remediation: CRUN_OOM_SCORE_ADJ_REMEDIATION,
  };
};

export const evaluateLibpodCrunExecCompatibility = (
  info: unknown,
  entry: KnownBadOciRuntime = KNOWN_BAD_CRUN,
): CrunExecCompatibilityWarning | undefined => {
  const runtime = readLibpodOciRuntime(info);
  return evaluateKnownBadOciRuntime(
    {
      runtimeName: runtime?.name,
      runtimeVersionBanner: runtime?.versionBanner,
      podmanVersion: readLibpodServerVersion(info),
      rootless: engineInfoRootless(info),
    },
    entry,
  );
};

/**
 * The crun exec failure, not a bare `oom_score_adj` token such as an
 * `ls /proc/self` listing. Matches wrapping text that still carries both
 * `write to /proc/self/oom_score_adj` and `Permission denied`.
 */
export const isCrunOomScoreAdjErrorText = (text: string): boolean =>
  text.includes("write to /proc/self/oom_score_adj") && text.includes("Permission denied");

export const mentionsAttachConnectionReset = (text: string): boolean =>
  text.includes(ATTACH_CONNECTION_RESET_SUBSTRING);

const textFromUnknown = (value: unknown, depth = 0): string => {
  if (depth > 4 || value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : "";
  const nested = ["body", "stderr", "details", "cause"].flatMap((key) => {
    const part = textFromUnknown(record[key], depth + 1);
    return part.length === 0 ? [] : [part];
  });
  return [message, ...nested].filter((part) => part.length > 0).join("\n");
};

export const failureMentionsCrunOomScoreAdj = (...parts: ReadonlyArray<unknown>): boolean =>
  parts.some((part) => isCrunOomScoreAdjErrorText(typeof part === "string" ? part : textFromUnknown(part)));

export const failureMentionsAttachConnectionReset = (...parts: ReadonlyArray<unknown>): boolean =>
  parts.some((part) =>
    mentionsAttachConnectionReset(typeof part === "string" ? part : textFromUnknown(part)),
  );
