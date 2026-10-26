import type { MountObservation, ObservedMount } from "@lando/sdk/schema";
import { Option, Schema } from "effect";

const MountInspect = Schema.Struct({
  Mounts: Schema.Array(
    Schema.Struct({
      Type: Schema.String,
      Destination: Schema.NonEmptyString,
      Source: Schema.optionalKey(Schema.String),
      Name: Schema.optionalKey(Schema.String),
      RW: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

export const mountObservationFromInspect = (inspect: unknown): MountObservation => {
  const decoded = Schema.decodeUnknownOption(MountInspect)(inspect);
  if (Option.isNone(decoded)) return { status: "unknown" };
  return {
    status: "present",
    mounts: decoded.value.Mounts.map((mount): ObservedMount => {
      const type =
        mount.Type === "bind" || mount.Type === "volume" || mount.Type === "tmpfs" ? mount.Type : "unknown";
      const source = type === "volume" ? mount.Name : mount.Source;
      return {
        type,
        target: mount.Destination,
        ...(source === undefined || source === "" ? {} : { source }),
        ...(mount.RW === undefined ? {} : { readOnly: !mount.RW }),
      };
    }),
  };
};
