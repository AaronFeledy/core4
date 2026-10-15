import { Schema } from "effect";
import {
  LANDOFILE_MERGE_DIRECTIVE,
  LandofileOverride,
  LandofileReset,
} from "../schema/landofile-directive.ts";

/** Replace a mapping member with this native authoring value when its layer is folded. */
export const override = <T>(value: T): LandofileOverride<T> => ({
  [LANDOFILE_MERGE_DIRECTIVE]: "override",
  value,
});
/** Remove a mapping member inherited from lower layers. */
export const reset = (): LandofileReset => ({ [LANDOFILE_MERGE_DIRECTIVE]: "reset" });

const Override = LandofileOverride(Schema.Unknown);
/** Narrow a native branded replacement directive, not a transport envelope. */
export const isLandofileOverride = Schema.is(Override);
/** Narrow a native branded removal directive, not a transport envelope. */
export const isLandofileReset = Schema.is(LandofileReset);
/** Recognize either native merge operation without interpreting ordinary mappings. */
export const isMergeDirective = (value: unknown): value is LandofileOverride<unknown> | LandofileReset =>
  isLandofileOverride(value) || isLandofileReset(value);
