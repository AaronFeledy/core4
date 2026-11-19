/**
 * `mailpit` global service — the bundled SMTP capture server + web UI that
 * runs inside the global Lando app.
 *
 * Packaging note: Mailpit ships from `@lando/service-lando` as a
 * `globalServices:` contribution. The module default-exports an `Effect`
 * producing a provider-neutral `ServiceConfig`, consumed by
 * `global configuration reconciliation` when materializing
 * `<userDataRoot>/global/.lando.dist.yml`.
 *
 * Mailpit's default entrypoint binds SMTP on `0.0.0.0:1025` and the web UI / API
 * on `0.0.0.0:8025`, so no custom start script is needed. The web UI is routed
 * through the global Traefik proxy at `mailpit.<proxy.defaultDomain>`, while per-app
 * services reach SMTP over the shared cross-app network via the projected
 * `LANDO_MAIL_HOST` / `LANDO_MAIL_PORT` contract.
 */

import { ServiceConfig } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

import {
  MAILPIT_DASHBOARD_HOSTNAME_EXPRESSION,
  MAILPIT_IMAGE,
  MAILPIT_READINESS_COMMAND,
  MAILPIT_SHARED_NETWORK_HOST,
  MAILPIT_SMTP_PORT,
  MAILPIT_WEB_PORT,
} from "../mailpit-constants.ts";

const mailpitServiceConfig = Schema.decodeUnknownSync(ServiceConfig)({
  api: 4,
  type: "compose",
  image: MAILPIT_IMAGE,
  readiness: {
    kind: "command",
    command: MAILPIT_READINESS_COMMAND,
    intervalSeconds: 0.5,
    timeoutSeconds: 2,
    retries: 12,
  },
  appMount: false,
  // Mail capture keeps no per-user state, so there is no home to persist.
  home: false,
  // Internal endpoints: SMTP is reached over the shared cross-app network,
  // and the web UI is reached through Traefik's hostname route below —
  // neither needs a host-published port.
  endpoints: [`tcp:${MAILPIT_SMTP_PORT}`, `http:${MAILPIT_WEB_PORT}`],
  hostnames: [MAILPIT_SHARED_NETWORK_HOST],
  routes: [{ hostname: MAILPIT_DASHBOARD_HOSTNAME_EXPRESSION, endpoint: MAILPIT_WEB_PORT }],
  environment: {},
});

const mailpitGlobalService: Effect.Effect<ServiceConfig> = Effect.succeed(mailpitServiceConfig);

export default mailpitGlobalService;
