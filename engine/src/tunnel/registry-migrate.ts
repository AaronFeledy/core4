import { Schema } from "effect";

import { RouteHostname, TunnelSession as TunnelSessionSchema, TunnelTarget } from "@lando/sdk/schema";

/** On-disk tunnel registry frame version; version 2 narrowed route target hostnames to RouteHostname. */
export const TUNNEL_REGISTRY_VERSION = 2 as const;

const TunnelRegistryEntry = Schema.Struct({
  session: TunnelSessionSchema,
  pid: Schema.Number.pipe(Schema.check(Schema.isInt())),
  updatedAt: Schema.String,
});

export const TunnelRegistryEntries = Schema.Array(TunnelRegistryEntry);

export type TunnelRegistryEntry = typeof TunnelRegistryEntry.Type;
export type TunnelRegistryEntries = typeof TunnelRegistryEntries.Type;

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
 * Upgrade a version 1 registry: drop only entries whose hostname string the narrowed grammar
 * rejects (version 1 allowed a 253-character suffix after `*.`); malformed records fail closed.
 */
export const migrateTunnelRegistryEntries = (raw: unknown, fromVersion: number): TunnelRegistryEntries => {
  Schema.decodeUnknownSync(Schema.Literal(1))(fromVersion);
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
