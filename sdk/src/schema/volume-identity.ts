import { Schema } from "effect";

import { AbsolutePath } from "./primitives.ts";

export const VolumeIdentity = Schema.Struct({
  coordinationKey: Schema.NonEmptyString.annotations({
    description: "Opaque daemon-namespace and native-volume key, stable across volume recreation.",
  }),
  nativeName: Schema.NonEmptyString.annotations({
    description: "Native volume name observed at the container mount destination.",
  }),
  generation: Schema.NonEmptyString.annotations({
    description: "Creation label or durable in-volume witness token, re-read before mutation.",
  }),
  ownerRoot: AbsolutePath.annotations({ description: "Canonical app root bound to this volume generation." }),
  origin: Schema.Literal("created", "adopted").annotations({
    description: "Creation fact or witnessed legacy adoption; adoption never proves freshness.",
  }),
});
export type VolumeIdentity = typeof VolumeIdentity.Type;
