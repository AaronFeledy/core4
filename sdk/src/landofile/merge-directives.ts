import { Schema } from "effect";
import {
  LANDOFILE_MERGE_DIRECTIVE,
  LandofileOverride,
  LandofileReset,
} from "../schema/landofile-directive.ts";

export const override = <T>(value: T): LandofileOverride<T> => ({
  [LANDOFILE_MERGE_DIRECTIVE]: "override",
  value,
});
export const reset = (): LandofileReset => ({ [LANDOFILE_MERGE_DIRECTIVE]: "reset" });

const Override = LandofileOverride(Schema.Unknown);
export const isLandofileOverride = Schema.is(Override);
export const isLandofileReset = Schema.is(LandofileReset);
export const isMergeDirective = (value: unknown): value is LandofileOverride<unknown> | LandofileReset =>
  isLandofileOverride(value) || isLandofileReset(value);
