import { Schema } from "effect";

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MIN_UNSCHEDULED_DEPRECATION_SINCE = { major: 4, minor: 1, patch: 0 } as const satisfies Semver;

type Semver = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
};

const parseSemver = (value: string): Semver | undefined => {
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) return undefined;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
};

const compareSemver = (left: Semver, right: Semver): number => {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
};

const isAbsoluteHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const SemverString = Schema.String.pipe(
  Schema.pattern(SEMVER_PATTERN, {
    message: () => "Version must be a semver string in major.minor.patch form.",
  }),
);

const OptionalHttpUrl = Schema.String.pipe(
  Schema.filter(isAbsoluteHttpUrl, {
    message: () => "docsUrl must be an absolute http(s) URL.",
    jsonSchema: { format: "uri" },
  }),
);

export const DeprecationSeverity = Schema.Literal("info", "warn", "error");
export type DeprecationSeverity = typeof DeprecationSeverity.Type;

const DEPRECATION_NOTICE_JSON_SCHEMA_METADATA = {
  title: "Deprecation Notice",
  description: "A structured deprecation declaration attached to a public surface.",
};

const DEPRECATION_NOTICE_JSON_SCHEMA = {
  ...DEPRECATION_NOTICE_JSON_SCHEMA_METADATA,
  type: "object",
  required: ["since", "note"],
  additionalProperties: false,
  properties: {
    since: {
      type: "string",
      pattern: SEMVER_PATTERN.source,
    },
    removeIn: {
      type: "string",
      pattern: SEMVER_PATTERN.source,
    },
    severity: {
      type: "string",
      enum: ["info", "warn", "error"],
    },
    replacement: {
      type: "string",
    },
    note: {
      type: "string",
    },
    docsUrl: {
      type: "string",
      format: "uri",
    },
    ticket: {
      type: "string",
    },
  },
} as const;

export const DeprecationNoticeJsonShape = Schema.Struct({
  since: SemverString,
  removeIn: Schema.optional(SemverString),
  severity: Schema.optionalWith(DeprecationSeverity, { default: () => "warn" as const }),
  replacement: Schema.optional(Schema.String),
  note: Schema.String,
  docsUrl: Schema.optional(OptionalHttpUrl),
  ticket: Schema.optional(Schema.String),
}).annotations({
  identifier: "DeprecationNotice",
  title: "Deprecation Notice",
  description: "A structured deprecation declaration attached to a public surface.",
  jsonSchema: DEPRECATION_NOTICE_JSON_SCHEMA,
});

const isFutureMajorOrMinorRemoval = (notice: typeof DeprecationNoticeJsonShape.Type): boolean => {
  if (notice.removeIn === undefined) return true;
  const since = parseSemver(notice.since);
  const removeIn = parseSemver(notice.removeIn);
  if (since === undefined || removeIn === undefined) return false;
  if (removeIn.patch !== 0) return false;
  return compareSemver(removeIn, since) > 0;
};

const hasRequiredScheduleForOldNotice = (notice: typeof DeprecationNoticeJsonShape.Type): boolean => {
  if (notice.removeIn !== undefined) return true;
  const since = parseSemver(notice.since);
  if (since === undefined) return false;
  return compareSemver(since, MIN_UNSCHEDULED_DEPRECATION_SINCE) >= 0;
};

export const DeprecationNotice = DeprecationNoticeJsonShape.pipe(
  Schema.filter(isFutureMajorOrMinorRemoval, {
    message: () =>
      "removeIn must be a future major or minor release; patch, same-release, and past removals are not allowed.",
    jsonSchema: DEPRECATION_NOTICE_JSON_SCHEMA,
  }),
  Schema.filter(hasRequiredScheduleForOldNotice, {
    message: () =>
      "Notices from releases older than the active 4.1.0 deprecation window must declare removeIn.",
    jsonSchema: DEPRECATION_NOTICE_JSON_SCHEMA,
  }),
).annotations({
  identifier: "DeprecationNotice",
  title: "Deprecation Notice",
  description: "A structured deprecation declaration attached to a public surface.",
  jsonSchema: DEPRECATION_NOTICE_JSON_SCHEMA,
});
export type DeprecationNotice = typeof DeprecationNotice.Type;

export type StructuralDeprecationKey = Pick<DeprecationNotice, "since" | "removeIn" | "note">;

export const structuralDeprecationKey = (notice: DeprecationNotice): StructuralDeprecationKey => ({
  since: notice.since,
  removeIn: notice.removeIn,
  note: notice.note,
});
