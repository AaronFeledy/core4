import { serviceCursor } from "./claims.ts";
import type { LoweringPatch, ServiceLoweringContext, V4Wire } from "./lowering-contract.ts";

export const lowerLegacySsl = (service: V4Wire, ctx: ServiceLoweringContext): LoweringPatch => {
  const cursor = serviceCursor(service, ctx);
  const diagnostics: LoweringPatch["diagnostics"][number][] = [];
  cursor.take(["ssl"]);
  if (service.ssl) {
    cursor.take(["sport"]);
    cursor.take(["sslExpose"]);
    if (service.sslExpose !== false) {
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
