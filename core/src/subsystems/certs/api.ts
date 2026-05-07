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
export { CertificateAuthority } from "@lando/sdk/services";
