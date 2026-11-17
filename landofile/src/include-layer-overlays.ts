import { LANDOFILE_MERGE_DIRECTIVE, isPlainRecord, mergeLandofiles } from "@lando/sdk/landofile";
import { LandofileShape } from "@lando/sdk/schema";
import { Predicate, Schema } from "effect";

const AcquisitionShape = Schema.Struct({
  includes: LandofileShape.schema.fields.includes,
  include: LandofileShape.schema.fields.include,
  toolingIncludes: LandofileShape.schema.fields.toolingIncludes,
  lando: Schema.optionalKey(Schema.String),
});
export const decodeIncludeAcquisition = Schema.decodeUnknownResult(AcquisitionShape);
const containsDirective = (value: unknown): boolean => {
  if (Predicate.hasProperty(value, LANDOFILE_MERGE_DIRECTIVE)) return true;
  if (Array.isArray(value)) return value.some(containsDirective);
  if (!isPlainRecord(value)) return false;
  return Object.values(value).some(containsDirective);
};

/**
 * Project a document to the include-acquisition surface.
 *
 * The projection is a value transform only: callers keep the source document's
 * provenance, because authored paths survive the projection.
 */
export const includeAcquisitionView = (overlay: Record<string, unknown>) => {
  const projection = Object.fromEntries(
    ["includes", "include", "toolingIncludes", "lando"].flatMap((key) =>
      Object.hasOwn(overlay, key) ? [[key, overlay[key]]] : [],
    ),
  );
  return Schema.decodeUnknownSync(AcquisitionShape)(
    containsDirective(projection) ? mergeLandofiles([projection]) : projection,
    { onExcessProperty: "error", errors: "all" },
  );
};
