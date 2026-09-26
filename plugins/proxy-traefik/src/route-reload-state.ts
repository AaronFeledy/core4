import { X509Certificate, createPublicKey } from "node:crypto";

import { Effect, Schema } from "effect";

import type { PluginStateStore } from "@lando/sdk/plugins";
import type { AppId } from "@lando/sdk/schema";

const AckSchema = Schema.Struct({ digest: Schema.String });
type Ack = typeof AckSchema.Type;

// Route files share one Traefik process, so writes and reloads for every app must
// be serialized together. A per-app lock could acknowledge app A after app B
// has already replaced the running configuration.
export const routeReloadLockKey = (): string => "routes.lock";

export const openRouteReloadAck = (stateStore: PluginStateStore, app: AppId) =>
  stateStore.open({
    namespace: "route-reloads",
    key: `app-${encodeURIComponent(String(app))}.json`,
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

export const certificatePairIsCurrent = (
  certificatePem: string,
  privateKeyPem: string,
  hostnames: ReadonlyArray<string>,
  now = Date.now(),
): boolean => {
  try {
    const certificate = new X509Certificate(certificatePem);
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || now < validFrom || now >= validTo)
      return false;
    // checkHost never matches a literal "*" label, so a wildcard route is
    // covered only by the same wildcard DNS entry in the certificate.
    const dnsNames = new Set(
      (certificate.subjectAltName ?? "")
        .split(", ")
        .filter((entry) => entry.startsWith("DNS:"))
        .map((entry) => entry.slice("DNS:".length).toLowerCase()),
    );
    const covers = (hostname: string) =>
      hostname.startsWith("*.")
        ? dnsNames.has(hostname.toLowerCase())
        : certificate.checkHost(hostname) !== undefined;
    if (!hostnames.every(covers)) return false;
    const certificateKey = certificate.publicKey.export({ type: "spki", format: "der" });
    const privateKey = createPublicKey(privateKeyPem).export({ type: "spki", format: "der" });
    return Buffer.from(certificateKey).equals(Buffer.from(privateKey));
  } catch {
    return false;
  }
};

export const isAcknowledged = (stateStore: PluginStateStore, app: AppId, digest: string) =>
  openRouteReloadAck(stateStore, app).pipe(
    Effect.flatMap((bucket) => bucket.get),
    Effect.map((ack: Ack | null) => ack?.digest === digest),
  );

export const acknowledge = (stateStore: PluginStateStore, app: AppId, digest: string) =>
  openRouteReloadAck(stateStore, app).pipe(Effect.flatMap((bucket) => bucket.set({ digest })));
export const invalidateAcknowledgement = (stateStore: PluginStateStore, app: AppId) =>
  openRouteReloadAck(stateStore, app).pipe(Effect.flatMap((bucket) => bucket.remove));
