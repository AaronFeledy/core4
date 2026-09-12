import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { resolveLiveProviderSocket } from "@lando/core/testing";
import { bringDown, bringUp, makePodmanApiClient } from "@lando/provider-lando";
import { TRAEFIK_DYNAMIC_CONFIG_DIR, TRAEFIK_IMAGE, renderTraefikDynamicConfig } from "@lando/proxy-traefik";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortNumber,
  ProviderId,
  type RoutePlan,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

const providerId = ProviderId.make("lando");
const TRAEFIK_WEB_PORT = 38082;
const BACKEND_PORT = 31083;
const SLUG = `route-filters-${crypto.randomUUID().slice(0, 8)}`;
const FILTERED_HOSTNAME = `filtered.${SLUG}.lndo.site`;
const RAW_HOSTNAME = `raw.${SLUG}.lndo.site`;
const BACKEND_CONTENT = "lando route filter backend\n";

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-30T00:00:00Z"),
  source: "route-filters-live.integration.test",
  runtime: 4 as const,
};

const appPlan = (slug: string, service: ServicePlan, planRoutes: ReadonlyArray<RoutePlan>): AppPlan => ({
  id: AppId.make(slug),
  name: slug,
  slug,
  root: AbsolutePath.make(`/tmp/lando-${slug}`),
  provider: providerId,
  services: { [service.name]: service },
  routes: planRoutes,
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

const backend = {
  service: ServiceName.make("web"),
  protocol: "http",
  port: PortNumber.make(BACKEND_PORT),
} as const;

const routes: ReadonlyArray<RoutePlan> = [
  {
    hostname: FILTERED_HOSTNAME,
    scheme: "http",
    service: backend.service,
    pathPrefix: "/api",
    filters: [
      { type: "stripPrefix", prefix: "/api" },
      { type: "responseHeader", header: "X-Lando-Route", value: "filtered" },
    ],
    backend,
  },
  {
    hostname: RAW_HOSTNAME,
    scheme: "http",
    service: backend.service,
    pathPrefix: "/api",
    backend,
  },
];

const nginxStartScript = [
  "cat > /usr/share/nginx/html/index.html <<'LANDO_CONTENT'",
  BACKEND_CONTENT.trimEnd(),
  "LANDO_CONTENT",
  "cat > /etc/nginx/conf.d/default.conf <<'LANDO_NGINX_CONF'",
  "server {",
  `  listen ${BACKEND_PORT};`,
  "  location / {",
  "    root /usr/share/nginx/html;",
  "    index index.html index.htm;",
  "  }",
  "}",
  "LANDO_NGINX_CONF",
  "exec nginx -g 'daemon off;'",
].join("\n");

const nginxService: ServicePlan = {
  name: backend.service,
  type: "compose",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "nginx:1.27" },
  command: ["sh", "-c", nginxStartScript],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [
    {
      _tag: "published",
      port: BACKEND_PORT,
      protocol: "http",
      name: "web",
      publication: { hostPort: BACKEND_PORT },
    },
  ],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const traefikStartScript = [
  `mkdir -p ${TRAEFIK_DYNAMIC_CONFIG_DIR}`,
  `cat > ${TRAEFIK_DYNAMIC_CONFIG_DIR}/route-filters.yml <<'LANDO_TRAEFIK_ROUTES'`,
  renderTraefikDynamicConfig(routes, AppId.make(SLUG)).trimEnd(),
  "LANDO_TRAEFIK_ROUTES",
  [
    "exec traefik",
    "--log.level=INFO",
    "--api.dashboard=true",
    "--api.insecure=true",
    `--entrypoints.web.address=:${TRAEFIK_WEB_PORT}`,
    "--entrypoints.traefik.address=:8080",
    `--providers.file.directory=${TRAEFIK_DYNAMIC_CONFIG_DIR}`,
    "--providers.file.watch=true",
  ].join(" "),
].join("\n");

const traefikService: ServicePlan = {
  name: ServiceName.make("traefik"),
  type: "compose",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: TRAEFIK_IMAGE },
  command: ["sh", "-c", traefikStartScript],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [
    {
      _tag: "published",
      port: TRAEFIK_WEB_PORT,
      protocol: "http",
      name: "web",
      publication: { hostPort: TRAEFIK_WEB_PORT },
    },
  ],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const fetchThroughTraefik = async (hostname: string, timeoutMs: number): Promise<Response> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${TRAEFIK_WEB_PORT}/api/index.html`, {
        headers: { Host: hostname },
        signal: AbortSignal.timeout(Math.min(5_000, Math.max(1, deadline - Date.now()))),
      });
      // Wait for nginx, not Traefik's own startup 404 or gateway errors.
      if (response.headers.get("server")?.includes("nginx")) return response;
      lastError = new Error(`HTTP ${response.status}`);
      await response.body?.cancel();
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Traefik did not route to nginx within ${timeoutMs}ms: ${String(lastError)}`);
};

describe("route filters — live integration", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "applies explicit filters while forwarding an unfiltered path prefix verbatim",
    async () => {
      // Given: two path routes to the same nginx backend, only one with filters.
      const socketPath = resolveLiveProviderSocket()?.socketPath ?? "";
      expect(socketPath).toBeTruthy();
      const api = makePodmanApiClient(socketPath);
      const backendPlan = appPlan(SLUG, nginxService, routes);
      const proxyPlan = appPlan(`${SLUG}-proxy`, traefikService, []);

      await Effect.runPromise(Effect.either(bringDown(proxyPlan, { api })));
      await Effect.runPromise(Effect.either(bringDown(backendPlan, { api })));
      try {
        const backendApplied = await Effect.runPromise(bringUp(backendPlan, { api }));
        expect(backendApplied.changed).toBe(true);
        const traefikApplied = await Effect.runPromise(bringUp(proxyPlan, { api }));
        expect(traefikApplied.changed).toBe(true);

        // When: the same path is requested through each Host-selected route.
        const filtered = await fetchThroughTraefik(FILTERED_HOSTNAME, 120_000);
        const raw = await fetchThroughTraefik(RAW_HOSTNAME, 120_000);

        // Then: stripping and response headers are explicit, never implicit.
        expect(filtered.status).toBe(200);
        expect(await filtered.text()).toBe(BACKEND_CONTENT);
        expect(filtered.headers.get("x-lando-route")).toBe("filtered");
        expect(raw.status).toBe(404);
        expect(await raw.text()).toContain("nginx");
        expect(raw.headers.get("x-lando-route")).toBeNull();
      } finally {
        await Effect.runPromise(Effect.either(bringDown(proxyPlan, { api })));
        await Effect.runPromise(Effect.either(bringDown(backendPlan, { api })));
      }
    },
    240_000,
  );
});
