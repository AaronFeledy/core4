import { type SchemaAST as AST, Effect, Result, Schema } from "effect";

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
  Schema.check(
    Schema.isPattern(SEMVER_PATTERN, {
      message: "Version must be a semver string in major.minor.patch form.",
      toJsonSchema: () => ({ pattern: SEMVER_PATTERN.source }),
    }),
  ),
);

const OptionalHttpUrl = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(isAbsoluteHttpUrl, {
      message: "docsUrl must be an absolute http(s) URL.",
      toJsonSchema: () => [{ format: "uri", pattern: "^[Hh][Tt][Tt][Pp][Ss]?://" }, true],
    }),
  ),
);

export const DeprecationSeverity = Schema.Literals(["info", "warn", "error"]);
export type DeprecationSeverity = typeof DeprecationSeverity.Type;

export const DeprecationSurfaceKind = Schema.Literals([
  "command",
  "flag",
  "arg",
  "tooling-task",
  "recipe",
  "recipe-prompt",
  "landofile-key",
  "config-key",
  "env-override",
  "schema",
  "schema-field",
  "event",
  "event-field",
  "render-event",
  "service-type",
  "service-feature",
  "route-filter",
  "provider-extension",
  "manifest-field",
  "manifest-contribution",
  "plugin",
  "export",
  "tagged-error",
]);
export type DeprecationSurfaceKind = typeof DeprecationSurfaceKind.Type;

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
      pattern: "^[Hh][Tt][Tt][Pp][Ss]?://",
    },
    ticket: {
      type: "string",
    },
  },
} as const;

export const DeprecationNoticeJsonShape = Schema.Struct({
  since: SemverString,
  removeIn: Schema.optionalKey(SemverString),
  severity: DeprecationSeverity.pipe(Schema.withDecodingDefaultKey(Effect.succeed("warn" as const))),
  replacement: Schema.optionalKey(Schema.String),
  note: Schema.String,
  docsUrl: Schema.optionalKey(OptionalHttpUrl),
  ticket: Schema.optionalKey(Schema.String),
}).annotate({
  identifier: "DeprecationNotice",
  title: "Deprecation Notice",
  description: "A structured deprecation declaration attached to a public surface.",
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
  Schema.check(
    Schema.makeFilter(isFutureMajorOrMinorRemoval, {
      message:
        "removeIn must be a future major or minor release; patch, same-release, and past removals are not allowed.",
      toJsonSchema: () => [DEPRECATION_NOTICE_JSON_SCHEMA, true],
    }),
  ),
  Schema.check(
    Schema.makeFilter(hasRequiredScheduleForOldNotice, {
      message: "Notices from releases older than the active 4.1.0 deprecation window must declare removeIn.",
      toJsonSchema: () => [DEPRECATION_NOTICE_JSON_SCHEMA, true],
    }),
  ),
).annotate({
  identifier: "DeprecationNotice",
  title: "Deprecation Notice",
  description: "A structured deprecation declaration attached to a public surface.",
});
export type DeprecationNotice = typeof DeprecationNotice.Type;

export type StructuralDeprecationKey = Pick<DeprecationNotice, "since" | "removeIn" | "note">;

export const structuralDeprecationKey = (notice: DeprecationNotice): StructuralDeprecationKey => ({
  since: notice.since,
  ...(notice.removeIn === undefined ? {} : { removeIn: notice.removeIn }),
  note: notice.note,
});

export const SchemaDeprecationAnnotationId = "lando/schema/DeprecationNotice" as const;

export type SchemaDeprecationAnnotation = DeprecationNotice;

type DeprecatedSchemaAnnotations = {
  readonly [SchemaDeprecationAnnotationId]: DeprecationNotice;
  readonly documentation?: string;
};

export const formatDeprecationNotice = (notice: DeprecationNotice): string => {
  const parts = [`Deprecated since ${notice.since}`];
  if (notice.removeIn !== undefined) parts.push(`remove in ${notice.removeIn}`);
  const schedule = `${parts.join("; ")}.`;
  const replacement = notice.replacement === undefined ? "" : ` Use ${notice.replacement} instead.`;
  return `${schedule}${replacement} ${notice.note}`;
};

const deprecatedAnnotations = (notice: DeprecationNotice): DeprecatedSchemaAnnotations => ({
  [SchemaDeprecationAnnotationId]: notice,
  documentation: formatDeprecationNotice(notice),
});

export const deprecateSchema = <S extends Schema.Top>(schema: S, notice: DeprecationNotice) =>
  schema.annotate(deprecatedAnnotations(notice));

export const deprecateField = <S extends Schema.Top>(schema: S, notice: DeprecationNotice) =>
  schema.annotateKey(deprecatedAnnotations(notice));

export const getSchemaDeprecation = (
  annotated: AST.AST | AST.PropertySignature,
): DeprecationNotice | undefined => {
  const ast = "type" in annotated ? annotated.type : annotated;
  const checkNotice = (checks: ReadonlyArray<AST.Check<unknown>>): unknown => {
    for (const check of [...checks].reverse()) {
      const own = check.annotations?.[SchemaDeprecationAnnotationId];
      if (own !== undefined) return own;
      if (check._tag === "FilterGroup") {
        const nested = checkNotice(check.checks);
        if (nested !== undefined) return nested;
      }
    }
    return undefined;
  };
  const notice =
    ast.context?.annotations?.[SchemaDeprecationAnnotationId] ??
    checkNotice(ast.checks ?? []) ??
    ast.annotations?.[SchemaDeprecationAnnotationId];
  return notice !== undefined && Schema.is(DeprecationNotice)(notice) ? notice : undefined;
};

export const validateDeprecationNotice = (notice: unknown): notice is DeprecationNotice =>
  notice !== undefined &&
  Result.isSuccess(Schema.decodeUnknownResult(DeprecationNotice)(notice, { onExcessProperty: "error" }));

export const DeprecationUse = Schema.Struct({
  kind: DeprecationSurfaceKind,
  id: Schema.String,
  notice: DeprecationNotice,
  callsite: Schema.optionalKey(Schema.String),
  app: Schema.optionalKey(Schema.String),
  plugin: Schema.optionalKey(Schema.String),
  timestamp: Schema.DateTimeUtcFromString,
}).annotate({
  identifier: "DeprecationUse",
  title: "Deprecation Use",
  description: "A recorded runtime use of a deprecated public surface.",
});
export type DeprecationUse = typeof DeprecationUse.Type;
