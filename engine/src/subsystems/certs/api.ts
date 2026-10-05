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
import { Layer } from "effect";

import { CaError } from "@lando/sdk/errors";
import { CertificateAuthority } from "@lando/sdk/services";
import { UNAVAILABLE_ID, unavailableOperation } from "../unavailable.ts";

export { CertificateAuthority };

const CA_UNAVAILABLE_MESSAGE =
  "CertificateAuthority requires @lando/ca-mkcert. Run `lando setup` to install the CA (full implementation is not available yet).";

export const layerUnavailable = Layer.succeed(
  CertificateAuthority,
  CertificateAuthority.of({
    id: UNAVAILABLE_ID,
    setup: unavailableOperation(() => new CaError({ message: CA_UNAVAILABLE_MESSAGE, caId: UNAVAILABLE_ID })),
    issueCert: unavailableOperation(
      () => new CaError({ message: CA_UNAVAILABLE_MESSAGE, caId: UNAVAILABLE_ID }),
    ),
  }),
);
