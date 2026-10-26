import type { Schema } from "effect";
import type { AuthoringDeepPartial, AuthoringEncoded } from "./landofile-authoring.ts";
import type { LandofileOverride, LandofileReset } from "./landofile-directive.ts";
import type { LandofileShape } from "./landofile.ts";

export type LandofileOverlayValue<T> = T extends readonly unknown[]
  ? { readonly [K in keyof T]: LandofileOverlayValue<T[K]> }
  : T extends object
    ? {
        readonly [K in keyof T]:
          | LandofileOverlayValue<T[K]>
          | LandofileOverride<LandofileOverlayValue<T[K]>>
          | LandofileReset;
      }
    : T;

export type LandofileOverlayInput = LandofileOverlayValue<
  Exclude<AuthoringDeepPartial<AuthoringEncoded<Schema.Codec.Encoded<typeof LandofileShape>>>, string>
>;
export type LandofileDecodedOverlay = LandofileOverlayValue<typeof LandofileShape.Type>;
