/**
 * Mailpit defaults shared by the bundled global service module and the per-app
 * `LANDO_MAIL_*` environment contract so the shipped service and projected
 * connection details never drift.
 */

/** Pinned Mailpit image. Override per-install via the user `.lando.yml`. */
export const MAILPIT_IMAGE = "axllent/mailpit:v1.30.1";
/** Default SMTP port Mailpit listens on. */
export const MAILPIT_SMTP_PORT = 1025;
/** Default web UI / HTTP API port Mailpit listens on. */
export const MAILPIT_WEB_PORT = 8025;
/** Default hostname the Mailpit web UI is exposed on. */
export const MAILPIT_DASHBOARD_HOSTNAME = "mailpit.lndo.site";
/** Shared cross-app network alias the global Mailpit service is reachable at. */
export const MAILPIT_SHARED_NETWORK_HOST = "mailpit.global.internal";
