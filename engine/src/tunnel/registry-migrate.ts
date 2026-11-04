import { Schema } from "effect";

import { RouteHostname, TunnelSession as TunnelSessionSchema, TunnelTarget } from "@lando/sdk/schema";

/**
 * On-disk tunnel registry frame version. Bumped when TunnelTarget hostname
 * narrowed onto RouteHostname so entry-level migration can keep valid sessions
 * instead of quarantining the whole registry.bin on one bad host.
 */
export const TUNNEL_REGISTRY_VERSION = 2 as const;

const TunnelRegistryEntry = Schema.Struct({
  session: TunnelSessionSchema,
  pid: Schema.Number.pipe(Schema.check(Schema.isInt())),
  updatedAt: Schema.String,
});

const TunnelRegistryEntries = Schema.Array(TunnelRegistryEntry);

export type TunnelRegistryEntry = typeof TunnelRegistryEntry.Type;
export type TunnelRegistryEntries = typeof TunnelRegistryEntries.Type;

export { TunnelRegistryEntries as TunnelRegistryEntriesSchema };

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
 * Upgrade a legacy tunnel registry payload to the current entry schema.
 *
 * Only rejected hostname strings drop their entry; malformed records fail closed.
 * Main allowed a 253-character suffix after `*.` (255 characters in total).
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
