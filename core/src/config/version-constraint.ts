/**
 * Pure Lando core version-constraint primitive for the top-level Landofile
 * `lando: <semver-range>` key (spec §7.4).
 *
 * Effect-free by design so it can run on the tooling hot path against the
 * embedded `CORE_VERSION` without provider contact. Range evaluation compares
 * by numeric `major.minor.patch` tuple and IGNORES prerelease/build metadata,
 * so a prerelease of a version within the numeric range satisfies the range
 * (`>=4.1` is satisfied by `4.1.0-beta.2`). This keeps constraints useful on
 * the dev/next channels without forcing prerelease-aware ranges.
 */

/** Env var that downgrades an unsatisfied constraint to a renderer warning. */
export const VERSION_CONSTRAINT_SKIP_ENV_VAR = "LANDO_SKIP_VERSION_CONSTRAINT";

/** A declared range paired with the merge layer / source that declared it. */
export interface VersionConstraintEntry {
  readonly range: string;
  readonly source: string;
}

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
  return landofile.lando === undefined ? [] : [{ range: landofile.lando, source: fallbackSource }];
};

/** Result of accumulating a set of constraint entries against a version. */
export interface ConstraintEvaluation {
  /** Entries whose `range` is not valid semver-range syntax. */
  readonly invalid: ReadonlyArray<VersionConstraintEntry>;
  /** Entries whose valid range is not satisfied by the running version. */
  readonly unsatisfied: ReadonlyArray<VersionConstraintEntry>;
}

interface SemverTuple {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Which components were explicitly written (for `^`/`~` expansion). */
  readonly minorSpecified: boolean;
  readonly patchSpecified: boolean;
}

interface Comparator {
  readonly op: ">=" | "<=" | ">" | "<" | "=";
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const VERSION_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?$/;

const parseTuple = (raw: string): SemverTuple | undefined => {
  const match = VERSION_PATTERN.exec(raw.trim());
  if (match === null) return undefined;
  const minorSpecified = match[2] !== undefined;
  const patchSpecified = match[3] !== undefined;
  return {
    major: Number(match[1]),
    minor: minorSpecified ? Number(match[2]) : 0,
    patch: patchSpecified ? Number(match[3]) : 0,
    minorSpecified,
    patchSpecified,
  };
};

const compareTuples = (
  left: { readonly major: number; readonly minor: number; readonly patch: number },
  right: { readonly major: number; readonly minor: number; readonly patch: number },
): number => {
  if (left.major !== right.major) return Math.sign(left.major - right.major);
  if (left.minor !== right.minor) return Math.sign(left.minor - right.minor);
  return Math.sign(left.patch - right.patch);
};

const comparator = (op: Comparator["op"], tuple: SemverTuple): Comparator => ({
  op,
  major: tuple.major,
  minor: tuple.minor,
  patch: tuple.patch,
});

const expandCaret = (tuple: SemverTuple): ReadonlyArray<Comparator> => {
  const upper =
    tuple.major > 0
      ? { major: tuple.major + 1, minor: 0, patch: 0 }
      : tuple.minor > 0
        ? { major: 0, minor: tuple.minor + 1, patch: 0 }
        : { major: 0, minor: 0, patch: tuple.patch + 1 };
  return [comparator(">=", tuple), { op: "<", ...upper }];
};

const expandTilde = (tuple: SemverTuple): ReadonlyArray<Comparator> => {
  // `~4` -> >=4.0.0 <5.0.0; `~4.1`/`~4.1.2` -> >=x <x.(minor+1).0
  const upper = tuple.minorSpecified
    ? { major: tuple.major, minor: tuple.minor + 1, patch: 0 }
    : { major: tuple.major + 1, minor: 0, patch: 0 };
  return [comparator(">=", tuple), { op: "<", ...upper }];
};

const OPERATOR_PATTERN = /^(>=|<=|>|<|=|\^|~)?(.*)$/;

const parseComparatorToken = (token: string): ReadonlyArray<Comparator> | undefined => {
  const match = OPERATOR_PATTERN.exec(token);
  if (match === null) return undefined;
  const operator = match[1] ?? "";
  const tuple = parseTuple(match[2] ?? "");
  if (tuple === undefined) return undefined;
  if (operator === "^") return expandCaret(tuple);
  if (operator === "~") return expandTilde(tuple);
  if (operator === "") return [comparator("=", tuple)];
  return [comparator(operator as Comparator["op"], tuple)];
};

/**
 * Parse a semver range into a flat AND-list of comparators. Returns `undefined`
 * for unparseable or unsupported forms (`||` unions and `x - y` hyphen ranges
 * are intentionally unsupported). Whitespace separates ANDed comparators.
 */
const parseRange = (range: string): ReadonlyArray<Comparator> | undefined => {
  const trimmed = range.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.includes("||") || / - /.test(trimmed)) return undefined;
  const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return undefined;
  const comparators: Comparator[] = [];
  for (const token of tokens) {
    const parsed = parseComparatorToken(token);
    if (parsed === undefined) return undefined;
    comparators.push(...parsed);
  }
  return comparators;
};

/** True when `range` is a valid, supported semver range. */
export const isValidSemverRange = (range: string): boolean => parseRange(range) !== undefined;

const satisfiesComparator = (version: SemverTuple, cmp: Comparator): boolean => {
  const comparison = compareTuples(version, cmp);
  switch (cmp.op) {
    case ">=":
      return comparison >= 0;
    case "<=":
      return comparison <= 0;
    case ">":
      return comparison > 0;
    case "<":
      return comparison < 0;
    case "=":
      return comparison === 0;
  }
};

/**
 * True when `version` satisfies `range`. Prerelease/build metadata on
 * `version` is ignored, so a prerelease within the numeric range satisfies it.
 * A malformed `version` or unparseable `range` yields `false`.
 */
export const satisfiesRange = (version: string, range: string): boolean => {
  const parsedVersion = parseTuple(version);
  const comparators = parseRange(range);
  if (parsedVersion === undefined || comparators === undefined) return false;
  return comparators.every((cmp) => satisfiesComparator(parsedVersion, cmp));
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
