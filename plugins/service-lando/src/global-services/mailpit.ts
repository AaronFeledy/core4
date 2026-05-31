/**
 * `mailpit` global service — the bundled SMTP capture server + web UI that
 * runs inside the global Lando app.
 *
 * Packaging note: Mailpit ships from `@lando/service-lando` as a
 * `globalServices:` contribution. The module default-exports an `Effect`
 * producing a provider-neutral `ServiceConfig`, consumed by
 * `meta:global:install` when materializing
 * `<userDataRoot>/global/.lando.dist.yml`.
 *
 * Mailpit's default entrypoint binds SMTP on `0.0.0.0:1025` and the web UI / API
 * on `0.0.0.0:8025`, so no custom start script is needed. The web UI is routed
 * through the global Traefik proxy at `mailpit.lndo.site`, while per-app
 * services reach SMTP over the shared cross-app network via the projected
 * `LANDO_MAIL_HOST` / `LANDO_MAIL_PORT` contract.
 */
import { Effect, Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

import {
  MAILPIT_DASHBOARD_HOSTNAME,
  MAILPIT_IMAGE,
  MAILPIT_SHARED_NETWORK_HOST,
  MAILPIT_SMTP_PORT,
  MAILPIT_WEB_PORT,
} from "../mailpit-constants.ts";

const mailpitServiceConfig = Schema.decodeUnknownSync(ServiceConfig)({
  api: 4,
  type: "compose",
  image: MAILPIT_IMAGE,
  appMount: false,
  ports: [String(MAILPIT_SMTP_PORT), String(MAILPIT_WEB_PORT)],
  hostnames: [MAILPIT_SHARED_NETWORK_HOST],
  routes: [{ hostname: MAILPIT_DASHBOARD_HOSTNAME, endpoint: MAILPIT_WEB_PORT }],
  environment: {},
});

const mailpitGlobalService: Effect.Effect<ServiceConfig> = Effect.succeed(mailpitServiceConfig);

export default mailpitGlobalService;
