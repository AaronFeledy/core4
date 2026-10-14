import { Schema, SchemaTransformation } from "effect";
import { isLandofileOverride, isLandofileReset, override, reset } from "../landofile/merge-directives.ts";
import { isPlainRecord } from "../landofile/record.ts";
import {
  LandofileLiteralWire,
  LandofileOverride,
  LandofileOverrideWire,
  LandofileReset,
  LandofileResetWire,
} from "./landofile-directive.ts";

const envelope = (value: Record<string, unknown>): boolean =>
  (value._tag === "LandofileReset" && Object.keys(value).length === 1) ||
  (["LandofileOverride", "LandofileLiteral"].includes(String(value._tag)) &&
    Object.hasOwn(value, "value") &&
    Object.keys(value).length === 2);

const encodeOpaque = (value: unknown): unknown => {
  if (isLandofileReset(value)) return { _tag: "LandofileReset" };
  if (isLandofileOverride(value)) return { _tag: "LandofileOverride", value: encodeOpaque(value.value) };
  if (Array.isArray(value)) return value.map(encodeOpaque);
  if (!isPlainRecord(value)) return value;
  const mapping = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeOpaque(entry)]));
  return envelope(value) ? { _tag: "LandofileLiteral", value: mapping } : mapping;
};

const decodeOpaque = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(decodeOpaque);
  if (!isPlainRecord(value)) return value;
  if (envelope(value)) {
    switch (value._tag) {
      case "LandofileReset":
        return reset();
      case "LandofileOverride":
        return override(decodeOpaque(value.value));
      case "LandofileLiteral":
        if (isPlainRecord(value.value))
          return Object.fromEntries(
            Object.entries(value.value).map(([key, entry]) => [key, decodeOpaque(entry)]),
          );
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeOpaque(entry)]));
};

const opaque = Schema.Union([LandofileLiteralWire, Schema.Unknown]).pipe(
  Schema.decodeTo(
    Schema.Unknown,
    SchemaTransformation.transform({ decode: decodeOpaque, encode: encodeOpaque }),
  ),
);

export const directiveMember = (value: Schema.Top, native: boolean): Schema.Top => {
  if (native) return Schema.Union([LandofileOverride(value), LandofileReset, value]);
  if (value.ast._tag === "Unknown" || value.ast._tag === "Any") return opaque;
  const replace = LandofileOverrideWire(value).pipe(
    Schema.decodeTo(
      LandofileOverride(Schema.toType(value)),
      SchemaTransformation.transform({
        decode: (input) => override(input.value),
        encode: (input) => ({ _tag: "LandofileOverride" as const, value: input.value }),
      }),
    ),
  );
  const remove = LandofileResetWire.pipe(
    Schema.decodeTo(
      LandofileReset,
      SchemaTransformation.transform({
        decode: () => reset(),
        encode: () => ({ _tag: "LandofileReset" as const }),
      }),
    ),
  );
  return Schema.Union([replace, remove, value]);
};
