import { Schema } from "effect";

import { PortNumber } from "./primitives.ts";

// ============================================================================
// Service-type resolution facts: capabilities a resolver declares about the
// listeners its own launcher owns.
// ============================================================================

/**
 * A generated HTTPS listener an owned launcher can serve the service's own
 * generated certificate on. The resolver emits the candidate port whether or
 * not a certificate has been requested yet; the association becomes active only
 * while the effective service config asks for a generated certificate and the
 * selected HTTPS route actually lands on that port. It is a capability
 * declaration, not a certificate request and not an authored endpoint.
 */
export const GeneratedCertificateEndpoint = Schema.Struct({
  port: PortNumber.annotateKey({
    description: "Container port of the generated HTTPS listener the owned launcher serves.",
  }),
}).annotate({
  identifier: "GeneratedCertificateEndpoint",
  title: "Generated Certificate Endpoint",
  description:
    "Owned launcher's HTTPS listener that can serve the service's generated certificate on this port.",
});
export type GeneratedCertificateEndpoint = typeof GeneratedCertificateEndpoint.Type;
