import { mergeLandofiles } from "@lando/sdk/landofile";
import { LandofileShape } from "@lando/sdk/schema";
import { Schema } from "effect";

import { copyLandofileProvenance } from "./copy-provenance.ts";

const overlaysByResolution = new WeakMap<object, ReadonlyArray<Record<string, unknown>>>();

export const rememberIncludeOverlays = <T extends object>(
  value: T,
  overlays: ReadonlyArray<Record<string, unknown>>,
): T => {
  overlaysByResolution.set(value, overlays);
  return value;
};

export const getIncludeOverlays = (value: Record<string, unknown>): ReadonlyArray<Record<string, unknown>> =>
  overlaysByResolution.get(value) ?? [value];

const AcquisitionShape = Schema.Struct({
  includes: LandofileShape.schema.fields.includes,
  include: LandofileShape.schema.fields.include,
  toolingIncludes: LandofileShape.schema.fields.toolingIncludes,
  lando: Schema.optionalKey(Schema.String),
});
export const includeAcquisitionView = (overlay: Record<string, unknown>) => {
  const projection = Object.fromEntries(
    ["includes", "include", "toolingIncludes", "lando"].flatMap((key) =>
      Object.hasOwn(overlay, key) ? [[key, overlay[key]]] : [],
    ),
  );
  return copyLandofileProvenance(
    overlay,
    Schema.decodeUnknownSync(AcquisitionShape)(mergeLandofiles([projection]), {
      onExcessProperty: "error",
      errors: "all",
    }),
  );
};
