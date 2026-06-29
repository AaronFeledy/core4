import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { resolveLiveProviderSocket } from "@lando/core/testing";
import { bringDown, bringUp, makePodmanApiClient } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import {
  TRAEFIK_DYNAMIC_CONFIG_DIR,
  TRAEFIK_IMAGE,
} from "../../../plugins/proxy-traefik/src/global-services/traefik.ts";

const providerId = ProviderId.make("lando");
const TRAEFIK_WEB_PORT = 38080;
const SHOP_BACKEND_PORT = 31081;
const SHOP_HOSTNAME = "web.shop.lndo.site";
const SHOP_BACKEND = `web.shop.internal:${SHOP_BACKEND_PORT}`;

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-30T00:00:00Z"),
  source: "global-traefik-live.integration.test",
  runtime: 4 as const,
};

const appPlan = (slug: string, service: ServicePlan): AppPlan => ({
  id: AppId.make(slug),
  name: slug,
  slug,
  root: AbsolutePath.make(`/tmp/lando-${slug}`),
  provider: providerId,
  services: { [service.name]: service },
  routes: [],
  networks: [],
  stores: [],
  metadata,
  extensions: {},
});

const nginxStartScript = [
  "cat > /etc/nginx/conf.d/default.conf <<'LANDO_NGINX_CONF'",
  "server {",
  `  listen ${SHOP_BACKEND_PORT};`,
  "  location / {",
  "    root /usr/share/nginx/html;",
  "    index index.html index.htm;",
  "  }",
  "}",
  "LANDO_NGINX_CONF",
  "exec nginx -g 'daemon off;'",
].join("\n");

const nginxService = (): ServicePlan => ({
  name: ServiceName.make("web"),
  type: "compose",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "nginx:1.27" },
  command: ["sh", "-c", nginxStartScript],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [{ port: SHOP_BACKEND_PORT, protocol: "http", name: "web" }],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const dynamicRouteConfig = [
  "http:",
  "  routers:",
  "    shop:",
  `      rule: "Host(\`${SHOP_HOSTNAME}\`)"`,
  "      service: shop",
  "      entryPoints:",
  "        - web",
  "  services:",
  "    shop:",
  "      loadBalancer:",
  "        servers:",
  `          - url: "http://${SHOP_BACKEND}"`,
  "",
].join("\n");

const traefikStartScript = [
  `mkdir -p ${TRAEFIK_DYNAMIC_CONFIG_DIR}`,
  `cat > ${TRAEFIK_DYNAMIC_CONFIG_DIR}/shop.yml <<'LANDO_TRAEFIK_SHOP'`,
  dynamicRouteConfig.trimEnd(),
  "LANDO_TRAEFIK_SHOP",
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

const traefikService = (): ServicePlan => ({
  name: ServiceName.make("traefik"),
  type: "compose",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: TRAEFIK_IMAGE },
  command: ["sh", "-c", traefikStartScript],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [{ port: TRAEFIK_WEB_PORT, protocol: "http", name: "web" }],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const fetchThroughTraefik = async (timeoutMs: number): Promise<Response> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${TRAEFIK_WEB_PORT}/`, {
        headers: { Host: SHOP_HOSTNAME },
      });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Traefik did not route to nginx within ${timeoutMs}ms: ${String(lastError)}`);
};

describe("global Traefik routing — live integration", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "routes a per-app service through Traefik by Host header over the shared cross-app network",
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath ?? "";
      expect(socketPath).toBeTruthy();

      const api = makePodmanApiClient(socketPath);
      const shopPlan = appPlan("shop", nginxService());
      const globalPlan = appPlan("global", traefikService());

      await Effect.runPromise(Effect.either(bringDown(globalPlan, { podmanApi: api })));
      await Effect.runPromise(Effect.either(bringDown(shopPlan, { podmanApi: api })));

      try {
        const shopApplied = await Effect.runPromise(bringUp(shopPlan, { podmanApi: api }));
        expect(shopApplied.changed).toBe(true);

        const traefikApplied = await Effect.runPromise(bringUp(globalPlan, { podmanApi: api }));
        expect(traefikApplied.changed).toBe(true);

        const response = await fetchThroughTraefik(120_000);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("nginx");
      } finally {
        await Effect.runPromise(Effect.either(bringDown(globalPlan, { podmanApi: api })));
        await Effect.runPromise(Effect.either(bringDown(shopPlan, { podmanApi: api })));
      }
    },
    240_000,
  );
});
