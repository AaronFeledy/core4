/**
 * `CertificateAuthority` service interface.
 *
 * Core owns certificate intent. `CertificateAuthority` plugins own issuance
 * and host trust.
 *
 * Required behaviors:
 * - A dev CA can be generated and trusted via `lando setup`.
 * - Service certs include SANs for the service id, the canonical internal
 *   alias, configured `hostnames:`, proxied hostnames, `localhost`, and
 *   `127.0.0.1`.
 * - Cert/key paths are exposed as `LANDO_SERVICE_CERT` and
 *   `LANDO_SERVICE_KEY` in service env.
 * - Corporate/custom CA injection via `security.ca:` is supported; the
 *   install-to-trust-store path is plugin-implemented.
 * - Trust-store install is `PrivilegeService`-aware on platforms that
 *   require elevation.
 */
import { Effect, Layer } from "effect";

import { CaError } from "@lando/sdk/errors";
import { CertificateAuthority } from "@lando/sdk/services";

export { CertificateAuthority };

const CA_UNAVAILABLE_ID = "unavailable" as const;
const CA_UNAVAILABLE_MESSAGE =
  "CertificateAuthority requires @lando/ca-mkcert. Run `lando setup` to install the CA (available in Beta with US-102 full implementation).";

export const CertificateAuthorityUnavailableLive = Layer.succeed(CertificateAuthority, {
  id: CA_UNAVAILABLE_ID,
  setup: (_opts) => Effect.fail(new CaError({ message: CA_UNAVAILABLE_MESSAGE, caId: CA_UNAVAILABLE_ID })),
  issueCert: (_spec) =>
    Effect.fail(new CaError({ message: CA_UNAVAILABLE_MESSAGE, caId: CA_UNAVAILABLE_ID })),
});
