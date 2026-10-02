import { Effect } from "effect";
import { Result, Schema } from "effect";

import { DeprecationNotice, DeprecationSeverity } from "../schema/deprecation.ts";

const GUIDE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export { DeprecationNotice, DeprecationSeverity };

export const GuideId = Schema.String.pipe(
  Schema.check(Schema.isPattern(GUIDE_ID_PATTERN, {
    message: "Guide id must be lowercase kebab-case (a-z, 0-9, hyphen).",
  })),
).annotate({ identifier: "GuideId" });
export type GuideId = typeof GuideId.Type;

export const GuidePlatform = Schema.Literals(["darwin", "linux", "win32", "wsl"]);
export type GuidePlatform = typeof GuidePlatform.Type;

const TabAxisValue = Schema.String.pipe(
  Schema.check(Schema.isPattern(GUIDE_ID_PATTERN, {
    message: "Axis values must be lowercase kebab-case (a-z, 0-9, hyphen).",
  })),
);

const TabAxis = Schema.Array(TabAxisValue).pipe(
  Schema.check(Schema.isMinLength(1, { message: "An axis must declare at least one value." })),
  Schema.check(Schema.makeFilter((values) => new Set(values).size === values.length, {
    message: "Axis values must be unique.",
    jsonSchema: {},
  })),
);

const AxisName = Schema.String.pipe(
  Schema.check(Schema.isPattern(GUIDE_ID_PATTERN, {
    message: "Axis names must be lowercase kebab-case (a-z, 0-9, hyphen).",
  })),
);

const Axes = Schema.Record(AxisName, TabAxis).pipe(
  Schema.check(Schema.makeFilter((axes) => Object.keys(axes).length >= 1, {
    message: "`axes:` must declare at least one axis.",
    jsonSchema: {},
  })),
);

const GuideVariantOverride = Schema.Struct({
  skip: Schema.optionalKey(Schema.Struct({ reason: Schema.String, until: Schema.optionalKey(Schema.String) })),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  platforms: Schema.optionalKey(Schema.Array(GuidePlatform)),
});

const Variants = Schema.Record(Schema.String, GuideVariantOverride);

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
  defaultLayer: Schema.optionalKey(Schema.Literals(["scenario", "e2e"])),
  provider: Schema.optionalKey(Schema.Literal("test")),
  timeout: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))).pipe(Schema.withDecodingDefaultKey(Effect.sync(() => 60000))),
  platforms: Schema.optionalKey(Schema.Array(GuidePlatform)),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  tabs: Schema.optionalKey(TabAxis),
  axes: Schema.optionalKey(Axes),
  variants: Schema.optionalKey(Variants),
  skip: Schema.optionalKey(Schema.Struct({
      reason: Schema.String,
      until: Schema.optionalKey(Schema.String),
    })),
  deprecated: Schema.optionalKey(DeprecationNotice),
}).annotate({
  identifier: "GuideFrontmatter",
  title: "Guide Frontmatter",
  description: "Executable guide frontmatter.",
});
export type GuideFrontmatter = typeof GuideFrontmatter.Type;

// Cross-field rules refine decode only; the exported schema stays a plain struct so its published JSON Schema keeps a single named definition.
const GuideFrontmatterChecked = GuideFrontmatter.pipe(
  Schema.check(Schema.makeFilter((frontmatter) => frontmatter.tabs === undefined || frontmatter.axes === undefined, {
    message: "`tabs:` and `axes:` are mutually exclusive; declare a single axis form.",
  })),
  Schema.check(Schema.makeFilter((frontmatter) => {
      if (frontmatter.variants === undefined) return true;
      const valid = new Set(validVariantKeys(frontmatter));
      return Object.keys(frontmatter.variants).every((key) => valid.has(key));
    }, {
      message: "Every `variants:` key must match a Cartesian cell of the declared `tabs:`/`axes:` values.",
    })),
);

export const decodeGuideFrontmatterEither = (
  input: unknown,
): Result.Result<GuideFrontmatter, Schema.SchemaError> =>
  Schema.decodeUnknownResult(GuideFrontmatterChecked)(input, { onExcessProperty: "error" });

export const decodeGuideFrontmatter = (input: unknown): GuideFrontmatter => {
  const decoded = decodeGuideFrontmatterEither(input);
  if (Result.isFailure(decoded)) throw decoded.failure;
  return decoded.success;
};
