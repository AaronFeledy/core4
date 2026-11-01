import { serviceCursor } from "./claims.ts";
import type { LoweringPatch, ServiceLoweringContext, V4Wire } from "./lowering-contract.ts";

/**
 * Lando 3's node plugin reads a numeric `ssl` as the port the app itself serves
 * HTTPS on; every other catalog type only tests `ssl` for truthiness and uses `sport`.
 */
const nodeHttpsPort = (id: string, ssl: unknown): number | undefined =>
  id === "node" && Number.isInteger(ssl) && Number(ssl) > 0 && Number(ssl) <= 65535 ? Number(ssl) : undefined;

export const lowerLegacySsl = (service: V4Wire, ctx: ServiceLoweringContext, id: string): LoweringPatch => {
  const cursor = serviceCursor(service, ctx);
  const diagnostics: LoweringPatch["diagnostics"][number][] = [];
  cursor.take(["ssl"]);
  if (service.ssl) {
    cursor.take(["sport"]);
    cursor.take(["sslExpose"]);
    const published = service.sslExpose !== false;
    const appPort = nodeHttpsPort(id, service.ssl);
    if (appPort !== undefined) {
      diagnostics.push(
        cursor.rewriteTree(
          ["ssl"],
          `Lando 3's node service served HTTPS on port ${appPort} with its certificates; declared an HTTPS endpoint on that port.`,
          "Keep the app serving TLS on that port with the Lando certificates.",
        ),
      );
      return {
        patch: {
          certs: true,
          endpoints: [
            published
              ? { _tag: "published", protocol: "https", port: appPort, publication: {} }
              : { _tag: "internal", protocol: "https", port: appPort },
          ],
        },
        diagnostics,
        claims: cursor.claims,
      };
    }
    if (published) {
      diagnostics.push(
        cursor.reviewTree(
          ["ssl"],
          `Lando 3 published container port ${service.sport ?? 443} for SSL. Certificates or ports: alone do not configure a TLS listener in Lando 4; HTTPS uses proxy routes.`,
          "Configure HTTPS proxy routes, or configure a TLS listener explicitly before publishing its port.",
        ),
      );
    }
    return { patch: { certs: true }, diagnostics, claims: cursor.claims };
  }
  for (const key of ["sport", "sslExpose"]) {
    if (Object.hasOwn(service, key))
      diagnostics.push(
        cursor.dropTree(
          [key],
          "Lando 3 ignored this SSL setting because ssl was falsy.",
          "Enable SSL and configure HTTPS proxy routes in Lando 4 if needed.",
        ),
      );
  }
  return { patch: service.ssl === false ? { certs: false } : {}, diagnostics, claims: cursor.claims };
};
