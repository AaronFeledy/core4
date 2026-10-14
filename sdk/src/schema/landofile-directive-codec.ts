import { Schema, SchemaTransformation } from "effect";
import { override, reset } from "../landofile/merge-directives.ts";
import { isPlainRecord } from "../landofile/record.ts";
import {
  LandofileOverride,
  LandofileOverrideWire,
  LandofileReset,
  LandofileResetWire,
} from "./landofile-directive.ts";

export const directiveMember = (value: Schema.Top, native: boolean): Schema.Top => {
  if (native) return Schema.Union([LandofileOverride(value), LandofileReset, value]);
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
  const ordinary =
    value.ast._tag === "Unknown" || value.ast._tag === "Any"
      ? value.check(
          Schema.makeFilter(
            (input) =>
              !isPlainRecord(input) ||
              !(
                (input._tag === "LandofileReset" && Object.keys(input).length === 1) ||
                (input._tag === "LandofileOverride" &&
                  Object.hasOwn(input, "value") &&
                  Object.keys(input).length === 2)
              ),
            {
              message:
                "This opaque authored mapping collides with a reserved directive wire envelope; rename its _tag before transporting it.",
            },
          ),
        )
      : value;
  return Schema.Union([replace, remove, ordinary]);
};
