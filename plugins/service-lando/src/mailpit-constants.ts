/**
 * Mailpit defaults shared by the bundled global service module and the per-app
 * `LANDO_MAIL_*` environment contract so the shipped service and projected
 * connection details never drift.
 */

/** Pinned Mailpit image. Override per-install via the user `.lando.yml`. */
export const MAILPIT_IMAGE = "docker.io/axllent/mailpit:v1.30.1";
/** Default SMTP port Mailpit listens on. */
export const MAILPIT_SMTP_PORT = 1025;
/** Default web UI / HTTP API port Mailpit listens on. */
export const MAILPIT_WEB_PORT = 8025;
/** Planner expression for the global Mailpit web UI hostname. */
export const MAILPIT_DASHBOARD_HOSTNAME_EXPRESSION = "mailpit.{{ proxy.defaultDomain }}";
/** Shared cross-app network alias the global Mailpit service is reachable at. */
export const MAILPIT_SHARED_NETWORK_HOST = "mailpit.global.internal";
