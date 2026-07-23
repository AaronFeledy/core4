/**
 * `traefik` global service — the bundled reverse proxy that runs inside the
 * global Lando app and routes per-app HTTP services by hostname.
 *
 * Packaging note: Traefik ships from this `@lando/proxy-traefik` plugin as a
 * `globalServices:` contribution. The module default-exports an `Effect`
 * producing a provider-neutral `ServiceConfig` (consumed by `meta:global:install`
 * when materializing `<userDataRoot>/global/.lando.dist.yml`).
 *
 * Routing is realized through Traefik's **file provider**, not the Docker
 * provider: Lando is provider-neutral (docker / podman / lando) and must not
 * require socket access or label injection on per-app containers. The static
 * config enables the file provider plus the dashboard, and the default dynamic
 * config (written at container start) exposes the dashboard on
 * `traefik.lndo.site` via the internal `api@internal` service. Per-app routers
 * are dropped into the same dynamic directory as apps start.
 */
import { Effect, Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

import { TRAEFIK_HTTPS_PORT, TRAEFIK_HTTP_PORT } from "../ports.ts";
import { TRAEFIK_DYNAMIC_CONFIG_SOURCE } from "../proxy.ts";

/** Pinned Traefik v3 image. Override per-install via the user `.lando.yml`. */
export const TRAEFIK_IMAGE = "traefik:v3.3";

/** Default hostname the Traefik dashboard is exposed on. */
export const TRAEFIK_DASHBOARD_HOSTNAME = "traefik.lndo.site";

/** In-container directory Traefik's file provider watches for dynamic routers. */
export const TRAEFIK_DYNAMIC_CONFIG_DIR = "/etc/traefik/dynamic";

/** Static Traefik flags (entrypoints + file provider + dashboard). */
export const TRAEFIK_STATIC_FLAGS: ReadonlyArray<string> = [
  "--log.level=INFO",
  "--api.dashboard=true",
  "--api.insecure=true",
  "--entrypoints.web.address=:80",
  "--entrypoints.websecure.address=:443",
  "--entrypoints.traefik.address=:8080",
  `--providers.file.directory=${TRAEFIK_DYNAMIC_CONFIG_DIR}`,
  "--providers.file.watch=true",
];

/** Default dynamic config exposing the dashboard via the file provider. */
export const TRAEFIK_DASHBOARD_DYNAMIC_CONFIG = [
  "http:",
  "  routers:",
  "    dashboard:",
  `      rule: "Host(\`${TRAEFIK_DASHBOARD_HOSTNAME}\`)"`,
  "      service: api@internal",
  "      entryPoints:",
  "        - web",
  "",
].join("\n");

const DASHBOARD_CONFIG_PATH = `${TRAEFIK_DYNAMIC_CONFIG_DIR}/dashboard.yml`;
const HEREDOC_DELIMITER = "LANDO_TRAEFIK_DASHBOARD";

/**
 * Container start script: materialize the dashboard router into the watched
 * dynamic directory, then exec Traefik with the static config. A heredoc keeps
 * the YAML intact without quote-escaping headaches inside `sh -c`.
 */
export const TRAEFIK_START_SCRIPT = [
  `mkdir -p ${TRAEFIK_DYNAMIC_CONFIG_DIR}`,
  `cat > ${DASHBOARD_CONFIG_PATH} <<'${HEREDOC_DELIMITER}'`,
  TRAEFIK_DASHBOARD_DYNAMIC_CONFIG.trimEnd(),
  HEREDOC_DELIMITER,
  `exec traefik ${TRAEFIK_STATIC_FLAGS.join(" ")}`,
].join("\n");

const traefikServiceConfig = Schema.decodeUnknownSync(ServiceConfig)({
  api: 4,
  type: "compose",
  image: TRAEFIK_IMAGE,
  appMount: false,
  command: ["sh", "-c", TRAEFIK_START_SCRIPT],
  mounts: [
    {
      type: "bind",
      source: TRAEFIK_DYNAMIC_CONFIG_SOURCE,
      target: TRAEFIK_DYNAMIC_CONFIG_DIR,
      readOnly: false,
    },
  ],
  endpoints: [
    {
      _tag: "published",
      name: "web",
      protocol: "http",
      port: 80,
      publication: { bindAddress: "127.0.0.1", hostPort: TRAEFIK_HTTP_PORT },
    },
    {
      _tag: "published",
      name: "websecure",
      protocol: "https",
      port: 443,
      publication: { bindAddress: "127.0.0.1", hostPort: TRAEFIK_HTTPS_PORT },
    },
  ],
  ports: ["8080"],
  environment: {},
});

/**
 * Default export: an Effect that yields the Traefik global `ServiceConfig`.
 * The global-service loader runs this Effect and decodes the result.
 */
const traefikGlobalService: Effect.Effect<ServiceConfig> = Effect.succeed(traefikServiceConfig);

export default traefikGlobalService;
