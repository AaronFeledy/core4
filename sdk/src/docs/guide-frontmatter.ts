import { Either, type ParseResult, Schema } from "effect";

import { NotImplementedError } from "../errors/index.ts";

const GUIDE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const DeprecationSeverity = Schema.Literal("info", "warn", "error");
export type DeprecationSeverity = typeof DeprecationSeverity.Type;

export const DeprecationNotice = Schema.Struct({
  since: Schema.String,
  removeIn: Schema.optional(Schema.String),
  severity: Schema.optionalWith(DeprecationSeverity, { default: () => "warn" as const }),
  replacement: Schema.optional(Schema.String),
  note: Schema.String,
  docsUrl: Schema.optional(Schema.String),
  ticket: Schema.optional(Schema.String),
}).annotations({
  identifier: "DeprecationNotice",
  title: "Deprecation Notice",
  description: "A structured deprecation declaration attached to a public surface.",
});
export type DeprecationNotice = typeof DeprecationNotice.Type;

export const GuideId = Schema.String.pipe(
  Schema.pattern(GUIDE_ID_PATTERN, {
    message: () => "Guide id must be lowercase kebab-case (a-z, 0-9, hyphen).",
  }),
).annotations({ identifier: "GuideId" });
export type GuideId = typeof GuideId.Type;

export const GuidePlatform = Schema.Literal("darwin", "linux", "win32", "wsl");
export type GuidePlatform = typeof GuidePlatform.Type;

const TabAxisValue = Schema.String.pipe(
  Schema.pattern(GUIDE_ID_PATTERN, {
    message: () => "`tabs:` values must be lowercase kebab-case (a-z, 0-9, hyphen).",
  }),
);

const TabAxisValues = Schema.Array(TabAxisValue).pipe(
  Schema.minItems(1, { message: () => "`tabs:` must declare at least one axis value." }),
  Schema.filter((values) => new Set(values).size === values.length, {
    message: () => "`tabs:` values must be unique.",
    jsonSchema: {},
  }),
);

export const GuideFrontmatter = Schema.Struct({
  id: GuideId,
  defaultLayer: Schema.optional(Schema.Literal("scenario")),
  provider: Schema.optional(Schema.Literal("test")),
  timeout: Schema.optionalWith(Schema.Number.pipe(Schema.int(), Schema.positive()), { default: () => 60000 }),
  platforms: Schema.optional(Schema.Array(GuidePlatform)),
  tags: Schema.optional(Schema.Array(Schema.String)),
  tabs: Schema.optional(TabAxisValues),
  skip: Schema.optional(
    Schema.Struct({
      reason: Schema.String,
      until: Schema.optional(Schema.String),
    }),
  ),
  deprecated: Schema.optional(DeprecationNotice),
}).annotations({
  identifier: "GuideFrontmatter",
  title: "Guide Frontmatter",
  description: "Alpha 2 executable guide frontmatter.",
});
export type GuideFrontmatter = typeof GuideFrontmatter.Type;

export const GUIDE_FRONTMATTER_BETA_REMEDIATION =
  "This guide frontmatter surface ships in Phase 3 Beta per §19.16 — see `spec/ROADMAP.md`.";

const betaKeyError = (key: "axes" | "variants"): NotImplementedError =>
  new NotImplementedError({
    message: `Guide frontmatter key \`${key}\` is not supported in Alpha 2.`,
    commandId: "guide.frontmatter",
    specSection: "§19.16",
    remediation: GUIDE_FRONTMATTER_BETA_REMEDIATION,
  });

const e2eLayerError = (): NotImplementedError =>
  new NotImplementedError({
    message: "Guide frontmatter `defaultLayer: e2e` is not supported in Alpha 2.",
    commandId: "guide.frontmatter",
    specSection: "§19.11",
    remediation: "Guide e2e scenarios ship in Phase 3 Beta per §19.11 — see `spec/ROADMAP.md`.",
  });

const findDeferredGuideFrontmatter = (input: unknown): NotImplementedError | undefined => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["axes", "variants"] as const) {
    if (Object.hasOwn(record, key)) return betaKeyError(key);
  }
  if (record.defaultLayer === "e2e") return e2eLayerError();
  return undefined;
};

export const decodeGuideFrontmatterEither = (
  input: unknown,
): Either.Either<GuideFrontmatter, NotImplementedError | ParseResult.ParseError> => {
  const deferred = findDeferredGuideFrontmatter(input);
  if (deferred !== undefined) return Either.left(deferred);
  return Schema.decodeUnknownEither(GuideFrontmatter)(input, { onExcessProperty: "error" });
};

export const decodeGuideFrontmatter = (input: unknown): GuideFrontmatter => {
  const decoded = decodeGuideFrontmatterEither(input);
  if (Either.isLeft(decoded)) throw decoded.left;
  return decoded.right;
};
