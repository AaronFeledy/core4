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
  HostConfig: Schema.optionalKey(
    Schema.Struct({
      Tmpfs: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
    }),
  ),
});

export const mountObservationFromInspect = (inspect: unknown): MountObservation => {
  const decoded = Schema.decodeUnknownOption(MountInspect)(inspect);
  if (Option.isNone(decoded)) return { status: "unknown" };
  const mounts = decoded.value.Mounts.map((mount): ObservedMount => {
    const type =
      mount.Type === "bind" || mount.Type === "volume" || mount.Type === "tmpfs" ? mount.Type : "unknown";
    const source = type === "volume" ? mount.Name : mount.Source;
    return {
      type,
      target: mount.Destination,
      ...(source === undefined || source === "" ? {} : { source }),
      ...(mount.RW === undefined ? {} : { readOnly: !mount.RW }),
    };
  });
  // Docker and Podman list HostConfig.Tmpfs mounts only there, never in Mounts.
  const listed = new Set(mounts.map((mount) => mount.target));
  for (const [target, options] of Object.entries(decoded.value.HostConfig?.Tmpfs ?? {})) {
    if (listed.has(target)) continue;
    mounts.push({ type: "tmpfs", target, readOnly: options.split(",").includes("ro") });
  }
  return { status: "present", mounts };
};
