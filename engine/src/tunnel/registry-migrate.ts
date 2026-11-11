import { RouteHostname, TunnelSession as TunnelSessionSchema, TunnelTarget } from "@lando/sdk/schema";
import { Schema, Struct } from "effect";

/** Version 3 stores registration facts; status is derived from current liveness. */
export const TUNNEL_REGISTRY_VERSION = 3 as const;

const TunnelRegistryEntry = Schema.Struct({
  session: TunnelSessionSchema.mapFields(Struct.omit(["status"])),
  pid: Schema.Number.pipe(Schema.check(Schema.isInt())),
  updatedAt: Schema.String,
});

export const TunnelRegistryEntries = Schema.Array(TunnelRegistryEntry);

export type TunnelRegistryEntry = typeof TunnelRegistryEntry.Type;
export type TunnelRegistryEntries = typeof TunnelRegistryEntries.Type;

const Version2Entries = Schema.Array(
  Schema.Struct({ ...TunnelRegistryEntry.fields, session: TunnelSessionSchema }),
);

const HistoricalRouteTarget = Schema.Struct({
  ...TunnelTarget.members[0].fields,
  hostname: Schema.optionalKey(Schema.String),
});
const HistoricalEntries = Schema.Array(
  Schema.Struct({
    ...TunnelRegistryEntry.fields,
    session: Schema.Struct({
      ...TunnelSessionSchema.fields,
      target: Schema.Union([HistoricalRouteTarget, ...TunnelTarget.members.slice(1)]),
    }),
  }),
);

/**
 * Drop legacy status snapshots. Version 1 also drops hostnames rejected by the
 * narrowed grammar (it allowed a 253-character suffix after `*.`). Malformed records fail closed.
 */
export const migrateTunnelRegistryEntries = (raw: unknown, fromVersion: number): TunnelRegistryEntries => {
  Schema.decodeUnknownSync(Schema.Literals([1, 2]))(fromVersion);
  if (fromVersion === 2) {
    return Schema.decodeUnknownSync(TunnelRegistryEntries)(Schema.decodeUnknownSync(Version2Entries)(raw));
  }
  const entries = Schema.decodeUnknownSync(HistoricalEntries)(raw);
  return Schema.decodeUnknownSync(TunnelRegistryEntries)(
    entries.filter(({ session }) => {
      const target = session.target;
      return (
        target._tag !== "route" || target.hostname === undefined || Schema.is(RouteHostname)(target.hostname)
      );
    }),
  );
};
