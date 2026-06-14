import { Either, type ParseResult, Schema } from "effect";

import { DeprecationNotice, DeprecationSeverity } from "../schema/deprecation.ts";

const GUIDE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export { DeprecationNotice, DeprecationSeverity };

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
    message: () => "Axis values must be lowercase kebab-case (a-z, 0-9, hyphen).",
  }),
);

const TabAxis = Schema.Array(TabAxisValue).pipe(
  Schema.minItems(1, { message: () => "An axis must declare at least one value." }),
  Schema.filter((values) => new Set(values).size === values.length, {
    message: () => "Axis values must be unique.",
    jsonSchema: {},
  }),
);

const AxisName = Schema.String.pipe(
  Schema.pattern(GUIDE_ID_PATTERN, {
    message: () => "Axis names must be lowercase kebab-case (a-z, 0-9, hyphen).",
  }),
);

const Axes = Schema.Record({ key: AxisName, value: TabAxis }).pipe(
  Schema.filter((axes) => Object.keys(axes).length >= 1, {
    message: () => "`axes:` must declare at least one axis.",
    jsonSchema: {},
  }),
);

const GuideVariantOverride = Schema.Struct({
  skip: Schema.optional(Schema.Struct({ reason: Schema.String, until: Schema.optional(Schema.String) })),
  tags: Schema.optional(Schema.Array(Schema.String)),
  platforms: Schema.optional(Schema.Array(GuidePlatform)),
});

const Variants = Schema.Record({ key: Schema.String, value: GuideVariantOverride });

const cartesianCells = (axes: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<string> =>
  axes
    .reduce<ReadonlyArray<ReadonlyArray<string>>>(
      (cells, values) => cells.flatMap((prefix) => values.map((value) => [...prefix, value])),
      [[]],
    )
    .map((cell) => cell.join("."));

const validVariantKeys = (frontmatter: {
  readonly tabs?: ReadonlyArray<string> | undefined;
  readonly axes?: { readonly [axis: string]: ReadonlyArray<string> } | undefined;
}): ReadonlyArray<string> => {
  if (frontmatter.tabs !== undefined) return cartesianCells([frontmatter.tabs]);
  if (frontmatter.axes !== undefined) return cartesianCells(Object.values(frontmatter.axes));
  return [];
};

export const GuideFrontmatter = Schema.Struct({
  id: GuideId,
  defaultLayer: Schema.optional(Schema.Literal("scenario", "e2e")),
  provider: Schema.optional(Schema.Literal("test")),
  timeout: Schema.optionalWith(Schema.Number.pipe(Schema.int(), Schema.positive()), { default: () => 60000 }),
  platforms: Schema.optional(Schema.Array(GuidePlatform)),
  tags: Schema.optional(Schema.Array(Schema.String)),
  tabs: Schema.optional(TabAxis),
  axes: Schema.optional(Axes),
  variants: Schema.optional(Variants),
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

// Cross-field rules refine decode only; the exported schema stays a plain struct so its published JSON Schema keeps a single named definition.
const GuideFrontmatterChecked = GuideFrontmatter.pipe(
  Schema.filter((frontmatter) => frontmatter.tabs === undefined || frontmatter.axes === undefined, {
    message: () => "`tabs:` and `axes:` are mutually exclusive; declare a single axis form.",
  }),
  Schema.filter(
    (frontmatter) => {
      if (frontmatter.variants === undefined) return true;
      const valid = new Set(validVariantKeys(frontmatter));
      return Object.keys(frontmatter.variants).every((key) => valid.has(key));
    },
    {
      message: () =>
        "Every `variants:` key must match a Cartesian cell of the declared `tabs:`/`axes:` values.",
    },
  ),
);

export const decodeGuideFrontmatterEither = (
  input: unknown,
): Either.Either<GuideFrontmatter, ParseResult.ParseError> =>
  Schema.decodeUnknownEither(GuideFrontmatterChecked)(input, { onExcessProperty: "error" });

export const decodeGuideFrontmatter = (input: unknown): GuideFrontmatter => {
  const decoded = decodeGuideFrontmatterEither(input);
  if (Either.isLeft(decoded)) throw decoded.left;
  return decoded.right;
};
