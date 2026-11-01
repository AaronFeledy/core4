import { Effect, Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

import {
  TRAEFIK_DIAGNOSTICS_CONTAINER_DIR,
  TRAEFIK_DIAGNOSTICS_HOSTNAME,
  TRAEFIK_DIAGNOSTICS_PORT,
  renderTraefikDiagnosticHtml,
  renderTraefikDiagnosticNginxConfig,
} from "../diagnostics.ts";

export const TRAEFIK_DIAGNOSTICS_IMAGE = "nginx:1.26-alpine" as const;
export const TRAEFIK_DIAGNOSTICS_COMMAND: ReadonlyArray<string> = [
  "sh",
  "-ec",
  [
    "umask 022",
    `mkdir -p '${TRAEFIK_DIAGNOSTICS_CONTAINER_DIR}'`,
    `cat > '${TRAEFIK_DIAGNOSTICS_CONTAINER_DIR}/nginx.conf' <<'LANDO_DIAGNOSTICS_NGINX'`,
    renderTraefikDiagnosticNginxConfig().trimEnd(),
    "LANDO_DIAGNOSTICS_NGINX",
    `cat > '${TRAEFIK_DIAGNOSTICS_CONTAINER_DIR}/404.html' <<'LANDO_DIAGNOSTICS_HTML'`,
    renderTraefikDiagnosticHtml().trimEnd(),
    "LANDO_DIAGNOSTICS_HTML",
    `exec nginx -c '${TRAEFIK_DIAGNOSTICS_CONTAINER_DIR}/nginx.conf' -g 'daemon off;'`,
  ].join("\n"),
];
// The backend answers every request with 404, so a 404 from the loopback is
// the readiness signal.
export const TRAEFIK_DIAGNOSTICS_HEALTHCHECK = {
  kind: "command",
  command: [
    "sh",
    "-c",
    `wget -q -S -Y off -O /dev/null http://127.0.0.1:${TRAEFIK_DIAGNOSTICS_PORT}/ 2>&1 | grep -q 'HTTP/1.1 404'`,
  ],
  intervalSeconds: 1,
  timeoutSeconds: 2,
  retries: 30,
} as const;

const diagnosticsServiceConfig = Schema.decodeUnknownSync(ServiceConfig)({
  api: 4,
  type: "compose",
  image: TRAEFIK_DIAGNOSTICS_IMAGE,
  appMount: false,
  routes: [],
  // Diagnostic pages keep no per-user state, so there is no home to persist.
  home: false,
  command: TRAEFIK_DIAGNOSTICS_COMMAND,
  mounts: [],
  endpoints: [{ _tag: "internal", protocol: "http", port: TRAEFIK_DIAGNOSTICS_PORT }],
  hostnames: [TRAEFIK_DIAGNOSTICS_HOSTNAME],
  healthcheck: TRAEFIK_DIAGNOSTICS_HEALTHCHECK,
  environment: {},
});

const diagnosticsGlobalService = Effect.succeed(diagnosticsServiceConfig);

export default diagnosticsGlobalService;
