import type { PluginStateStore } from "@lando/sdk/plugins";
import type { AppRouteOwner } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

const AckSchema = Schema.Struct({ digest: Schema.String });
type Ack = typeof AckSchema.Type;

// Route files share one Traefik process, so writes and reloads for every app must
// be serialized together. A per-app lock could acknowledge app A after app B
// has already replaced the running configuration.
export const routeReloadLockKey = (): string => "routes.lock";

export const openRouteReloadAck = (stateStore: PluginStateStore, ownerKey: AppRouteOwner["ownerKey"]) =>
  stateStore.open({
    namespace: "route-reloads",
    key: `owner-${ownerKey}.json`,
    schema: AckSchema,
    version: 1,
    codec: "json",
    mode: 0o600,
    lock: "advisory",
    onCorrupt: "discard",
    onVersionMismatch: "discard",
  });

export const routeReloadDigest = (values: ReadonlyArray<string | undefined>): string => {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(
    JSON.stringify(
      values.map((value) => (value === undefined ? { present: false } : { present: true, value })),
    ),
  );
  return hash.digest("hex");
};

export const isAcknowledged = (
  stateStore: PluginStateStore,
  ownerKey: AppRouteOwner["ownerKey"],
  digest: string,
) =>
  openRouteReloadAck(stateStore, ownerKey).pipe(
    Effect.flatMap((bucket) => bucket.get),
    Effect.map((ack: Ack | null) => ack?.digest === digest),
  );

export const acknowledge = (
  stateStore: PluginStateStore,
  ownerKey: AppRouteOwner["ownerKey"],
  digest: string,
) => openRouteReloadAck(stateStore, ownerKey).pipe(Effect.flatMap((bucket) => bucket.set({ digest })));
export const invalidateAcknowledgement = (
  stateStore: PluginStateStore,
  ownerKey: AppRouteOwner["ownerKey"],
) => openRouteReloadAck(stateStore, ownerKey).pipe(Effect.flatMap((bucket) => bucket.remove));
