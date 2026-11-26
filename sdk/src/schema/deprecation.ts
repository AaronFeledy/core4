import { type SchemaAST as AST, Result, Schema } from "effect";
import { withDefaultKey } from "./default-key.ts";
import { SEMVER_CORE_PATTERN, patternString } from "./string-forms.ts";

type Semver = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
};

const parseSemver = (value: string): Semver | undefined => {
  const match = SEMVER_CORE_PATTERN.exec(value);
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

const SemverString = patternString(SEMVER_CORE_PATTERN, {
  message: "Version must be a semver string in major.minor.patch form.",
  toJsonSchema: () => ({ pattern: SEMVER_CORE_PATTERN.source }),
});

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
      pattern: SEMVER_CORE_PATTERN.source,
      description: "First release where this surface is deprecated (major.minor.patch).",
    },
    removeIn: {
      type: "string",
      pattern: SEMVER_CORE_PATTERN.source,
      description: "Release that removes the surface; must be later than since when set.",
    },
    severity: {
      type: "string",
      enum: ["info", "warn", "error"],
      description: "How strongly callers are told to stop using the surface (default warn).",
    },
    replacement: {
      type: "string",
      description: "Preferred replacement surface or migration target, when one exists.",
    },
    note: {
      type: "string",
      description: "Human-readable explanation of the deprecation and what to do next.",
    },
    docsUrl: {
      type: "string",
      format: "uri",
      pattern: "^[Hh][Tt][Tt][Pp][Ss]?://",
      description: "Absolute http(s) URL with migration or replacement documentation.",
    },
    ticket: {
      type: "string",
      description: "Tracker id or URL for the deprecation or removal work.",
    },
  },
} as const;

export const DeprecationNoticeJsonShape = Schema.Struct({
  since: SemverString.annotateKey({
    description: "First release where this surface is deprecated (major.minor.patch).",
  }),
  removeIn: Schema.optionalKey(SemverString).annotateKey({
    description: "Release that removes the surface; must be later than since when set.",
  }),
  severity: DeprecationSeverity.pipe(
    withDefaultKey("warn", {
      description: "How strongly callers are told to stop using the surface (default warn).",
    }),
  ).annotateKey({
    description: "How strongly callers are told to stop using the surface (default warn).",
  }),
  replacement: Schema.optionalKey(Schema.String).annotateKey({
    description: "Preferred replacement surface or migration target, when one exists.",
  }),
  note: Schema.String.annotateKey({
    description: "Human-readable explanation of the deprecation and what to do next.",
  }),
  docsUrl: Schema.optionalKey(OptionalHttpUrl).annotateKey({
    description: "Absolute http(s) URL with migration or replacement documentation.",
  }),
  ticket: Schema.optionalKey(Schema.String).annotateKey({
    description: "Tracker id or URL for the deprecation or removal work.",
  }),
}).annotate({
  identifier: "DeprecationNotice",
  title: "Deprecation Notice",
  description: "A structured deprecation declaration attached to a public surface.",
});

const isRemovalLaterThanSince = (notice: typeof DeprecationNoticeJsonShape.Type): boolean => {
  if (notice.removeIn === undefined) return true;
  const since = parseSemver(notice.since);
  const removeIn = parseSemver(notice.removeIn);
  if (since === undefined || removeIn === undefined) return false;
  return compareSemver(removeIn, since) > 0;
};

export const DeprecationNotice = DeprecationNoticeJsonShape.pipe(
  Schema.check(
    Schema.makeFilter(isRemovalLaterThanSince, {
      message: "removeIn must be a later release than since.",
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

/** The one human rendering of a notice: schedule, replacement, note, then the docs link. */
export const formatDeprecationNotice = (notice: DeprecationNotice): string => {
  const parts = [`Deprecated since ${notice.since}`];
  if (notice.removeIn !== undefined) parts.push(`scheduled for removal in ${notice.removeIn}`);
  const schedule = `${parts.join("; ")}.`;
  const replacement = notice.replacement === undefined ? "" : ` Use ${notice.replacement} instead.`;
  const docs = notice.docsUrl === undefined ? "" : ` Docs: ${notice.docsUrl}`;
  return `${schedule}${replacement} ${notice.note}${docs}`;
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
