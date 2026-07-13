/**
 * Pure Lando core version-constraint primitive for the top-level Landofile
 * `lando: <semver-range>` key.
 *
 * Effect-free by design so it can run on the tooling hot path against the
 * embedded `CORE_VERSION` without provider contact. Range evaluation compares
 * by npm-semver precedence and ignores build metadata. Running prereleases are
 * normalized to their numeric tuple before matching so `4.1.0-beta.2`
 * so a prerelease of a version within the numeric range satisfies the range
 * (`>=4.1` is satisfied by `4.1.0-beta.2`). This keeps constraints useful on
 * the dev/next channels without forcing prerelease-aware ranges.
 */

import { Range, parse, satisfies, validRange } from "semver";

/** Env var that downgrades an unsatisfied constraint to a renderer warning. */
export const VERSION_CONSTRAINT_SKIP_ENV_VAR = "LANDO_SKIP_VERSION_CONSTRAINT";

export type VersionConstraintLayer = "base" | "dist" | "upstream" | "canonical" | "local" | "user";
export type VersionConstraintOrder = 0 | 1 | 2 | 3 | 4 | 5;

/** A declared range paired with the merge layer / source that declared it. */
export interface VersionConstraintEntry {
  readonly range: string;
  readonly source: string;
  readonly layer: VersionConstraintLayer;
  readonly order: VersionConstraintOrder;
}

const orderForLayer = (layer: unknown): VersionConstraintOrder | undefined => {
  switch (layer) {
    case "base":
      return 0;
    case "dist":
      return 1;
    case "upstream":
      return 2;
    case "canonical":
      return 3;
    case "local":
      return 4;
    case "user":
      return 5;
    default:
      return undefined;
  }
};

export const isVersionConstraintEntryArray = (
  value: unknown,
): value is ReadonlyArray<VersionConstraintEntry> =>
  Array.isArray(value) &&
  value.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    if (!("range" in entry) || typeof entry.range !== "string") return false;
    if (!("source" in entry) || typeof entry.source !== "string") return false;
    if (!("layer" in entry) || !("order" in entry)) return false;
    return orderForLayer(entry.layer) === entry.order;
  });

export const hasSkippedUnsatisfiedVersionConstraint = (
  entries: ReadonlyArray<VersionConstraintEntry>,
  runningVersion: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean =>
  isVersionConstraintSkipped(env) &&
  evaluateVersionConstraints(entries, runningVersion).unsatisfied.length > 0;

const landofileVersionConstraintEntries = new WeakMap<object, ReadonlyArray<VersionConstraintEntry>>();

export const rememberVersionConstraintEntries = <T extends object>(
  landofile: T,
  entries: ReadonlyArray<VersionConstraintEntry>,
): T => {
  landofileVersionConstraintEntries.set(landofile, entries);
  return landofile;
};

export const getVersionConstraintEntries = (
  landofile: { readonly lando?: string | undefined },
  fallbackSource: string,
): ReadonlyArray<VersionConstraintEntry> => {
  const remembered = landofileVersionConstraintEntries.get(landofile);
  if (remembered !== undefined) return remembered;
  return landofile.lando === undefined
    ? []
    : [{ range: landofile.lando, source: fallbackSource, layer: "canonical", order: 3 }];
};

/** Result of accumulating a set of constraint entries against a version. */
export interface ConstraintEvaluation {
  /** Entries whose `range` is not valid semver-range syntax. */
  readonly invalid: ReadonlyArray<VersionConstraintEntry>;
  /** Entries whose valid range is not satisfied by the running version. */
  readonly unsatisfied: ReadonlyArray<VersionConstraintEntry>;
}

export const isValidSemverRange = (range: string): boolean =>
  range.trim().length > 0 && validRange(range, { loose: false }) !== null;

/**
 * True when `version` satisfies `range`. Prerelease/build metadata on
 * `version` is ignored, so a prerelease within the numeric range satisfies it.
 * A malformed `version` or unparseable `range` yields `false`.
 */
export const satisfiesRange = (version: string, range: string): boolean => {
  const parsedVersion = parse(version, { loose: false });
  if (parsedVersion === null || !isValidSemverRange(range)) return false;
  const options = { includePrerelease: true, loose: false } as const;
  const releaseVersion = `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch}`;
  return new Range(range, options).set.some((comparators) => {
    const hasExplicitPrerelease = comparators.some(
      (comparator) => comparator.value !== "" && comparator.semver.prerelease.length > 0,
    );
    const comparatorSet = comparators.map((comparator) => comparator.value).join(" ");
    return satisfies(hasExplicitPrerelease ? parsedVersion.version : releaseVersion, comparatorSet, options);
  });
};

/**
 * Accumulate a set of `{range, source}` constraints against the running
 * version. Every valid range must be satisfied; a lower-precedence layer can
 * never loosen a stricter higher-precedence one because each range is checked
 * independently. Invalid ranges are surfaced separately for a parse-level error.
 */
export const evaluateVersionConstraints = (
  entries: ReadonlyArray<VersionConstraintEntry>,
  runningVersion: string,
): ConstraintEvaluation => {
  const invalid: VersionConstraintEntry[] = [];
  const unsatisfied: VersionConstraintEntry[] = [];
  for (const entry of entries) {
    if (!isValidSemverRange(entry.range)) {
      invalid.push(entry);
      continue;
    }
    if (!satisfiesRange(runningVersion, entry.range)) unsatisfied.push(entry);
  }
  return { invalid, unsatisfied };
};

/** True when `LANDO_SKIP_VERSION_CONSTRAINT=1` is set for this invocation. */
export const isVersionConstraintSkipped = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[VERSION_CONSTRAINT_SKIP_ENV_VAR] === "1";
