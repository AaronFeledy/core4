/**
 * Bundled Traefik global service (`globalServices:` → provider-neutral `ServiceConfig`).
 *
 * Routing uses Traefik's file provider, not the Docker provider: Lando must not
 * require socket access or label injection on per-app containers. Static flags
 * enable the file provider and dashboard; the start script writes the dashboard
 * router into the watched dynamic directory.
 */
import { Effect, Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

import { TRAEFIK_HTTPS_PORT, TRAEFIK_HTTP_PORT } from "../ports.ts";
import { TRAEFIK_DYNAMIC_CONFIG_SOURCE } from "../proxy.ts";

/** Override per-install via the user `.lando.yml`. */
export const TRAEFIK_IMAGE = "traefik:v3.3";

export const TRAEFIK_DASHBOARD_HOSTNAME = "traefik.lndo.site";

/** In-container directory Traefik's file provider watches for dynamic routers. */
export const TRAEFIK_DYNAMIC_CONFIG_DIR = "/etc/traefik/dynamic";

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
 * Materialize the dashboard router, then exec Traefik. A heredoc keeps the YAML
 * intact without quote-escaping inside `sh -c`.
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
  extra_hosts: { "host.lando.internal": "host-gateway" },
  cap_add: ["NET_BIND_SERVICE"],
  environment: {},
});

const traefikGlobalService: Effect.Effect<ServiceConfig> = Effect.succeed(traefikServiceConfig);

export default traefikGlobalService;
