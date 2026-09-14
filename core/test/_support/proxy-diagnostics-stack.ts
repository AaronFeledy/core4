import { expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect } from "effect";

import { bringDown, bringUp, exec, makePodmanApiClient, pullImage } from "@lando/provider-lando";
import {
  TRAEFIK_DIAGNOSTICS_COMMAND,
  TRAEFIK_DIAGNOSTICS_CONTAINER_DIR,
  TRAEFIK_DIAGNOSTICS_HEALTHCHECK,
  TRAEFIK_DIAGNOSTICS_HOSTNAME,
  TRAEFIK_DIAGNOSTICS_ID,
  TRAEFIK_DIAGNOSTICS_IMAGE,
  TRAEFIK_DYNAMIC_CONFIG_DIR,
  TRAEFIK_IMAGE,
  renderTraefikDiagnosticHtml,
  renderTraefikDiagnosticNginxConfig,
  renderTraefikDynamicConfig,
  renderTraefikFallbackConfig,
} from "@lando/proxy-traefik";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortNumber,
  PortablePath,
  ProviderId,
  type RoutePlan,
  ServiceName,
  type ServicePlan,
  landoNetworkingPlan,
} from "@lando/sdk/schema";

import {
  BACKEND_CONTENT,
  TRAEFIK_WEBSECURE_PORT,
  TRAEFIK_WEB_PORT,
  waitForMatchedRoute,
} from "./proxy-diagnostics-requests.ts";

const providerId = ProviderId.make("lando");
const BACKEND_PORT = 31087;
const BACKEND_IMAGE = "nginx:1.27";

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-09-13T00:00:00Z"),
  source: "proxy-diagnostics-live.integration.test",
  runtime: 4 as const,
};

type ServiceOverrides = Partial<
  Pick<ServicePlan, "command" | "mounts" | "endpoints" | "dependsOn" | "healthcheck">
>;

const servicePlan = (name: string, artifact: string, overrides: ServiceOverrides): ServicePlan => ({
  name: ServiceName.make(name),
  type: "compose",
  provider: providerId,
  primary: false,
  artifact: { kind: "ref", ref: artifact },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
  ...overrides,
});

const bindMount = (source: string, target: string, readOnly: boolean): ServicePlan["mounts"][number] => ({
  type: "bind",
  source,
  target: PortablePath.make(target),
  readOnly,
  realization: "passthrough",
});

const publishedHttp = (name: string, port: number, hostPort: number): ServicePlan["endpoints"][number] => ({
  _tag: "published",
  port: PortNumber.make(port),
  protocol: "http",
  name,
  publication: { bindAddress: "127.0.0.1", hostPort: PortNumber.make(hostPort) },
});

const backendStartScript = [
  "cat > /usr/share/nginx/html/index.html <<'LANDO_CONTENT'",
  BACKEND_CONTENT.trimEnd(),
  "LANDO_CONTENT",
  "cat > /etc/nginx/conf.d/default.conf <<'LANDO_NGINX_CONF'",
  `server { listen ${BACKEND_PORT}; location / { root /usr/share/nginx/html; index index.html; } }`,
  "LANDO_NGINX_CONF",
  "exec nginx -g 'daemon off;'",
].join("\n");

// The global Traefik launch flags that matter for fallback routing. The dynamic
// directory is bind-mounted with every file already present, so no watcher.
const traefikStartScript = [
  "exec traefik",
  "--log.level=INFO",
  "--entrypoints.web.address=:80",
  "--entrypoints.websecure.address=:443",
  `--providers.file.directory=${TRAEFIK_DYNAMIC_CONFIG_DIR}`,
  "--providers.file.watch=false",
].join(" ");

export interface ProxyDiagnosticsStack {
  readonly plan: AppPlan;
  readonly api: ReturnType<typeof makePodmanApiClient>;
  readonly matchedHostname: string;
  readonly stop: () => Promise<void>;
}

const writeProxyFiles = async (root: string, slug: string, routes: ReadonlyArray<RoutePlan>) => {
  const diagnosticDir = join(root, "diagnostic");
  const dynamicDir = join(root, "dynamic");
  await mkdir(diagnosticDir, { recursive: true });
  await mkdir(dynamicDir, { recursive: true });
  await writeFile(join(diagnosticDir, "nginx.conf"), renderTraefikDiagnosticNginxConfig(), { mode: 0o644 });
  await writeFile(join(diagnosticDir, "404.html"), renderTraefikDiagnosticHtml(), { mode: 0o644 });
  // The harness stays on the per-app bridge, where the diagnostic backend is
  // addressed by its service name instead of the global cross-app hostname.
  await writeFile(
    join(dynamicDir, "fallback.yml"),
    renderTraefikFallbackConfig().replace(TRAEFIK_DIAGNOSTICS_HOSTNAME, TRAEFIK_DIAGNOSTICS_ID),
  );
  await writeFile(
    join(dynamicDir, `routes-${slug}.yml`),
    renderTraefikDynamicConfig(routes, AppId.make(slug)),
  );
  return { diagnosticDir, dynamicDir };
};

export const startProxyDiagnosticsStack = async (socketPath: string): Promise<ProxyDiagnosticsStack> => {
  const slug = `proxy-diag-${crypto.randomUUID().slice(0, 8)}`;
  const matchedHostname = `web.${slug}.lndo.site`;
  const root = await mkdtemp(join(tmpdir(), "lando-proxy-diag-"));
  const backend = {
    service: ServiceName.make("web"),
    protocol: "http",
    port: PortNumber.make(BACKEND_PORT),
  } as const;
  const routes: ReadonlyArray<RoutePlan> = [
    {
      hostname: matchedHostname,
      scheme: "both",
      service: backend.service,
      backend: { ...backend, host: "web" },
    },
  ];
  const { diagnosticDir, dynamicDir } = await writeProxyFiles(root, slug, routes);

  const services = {
    web: servicePlan("web", BACKEND_IMAGE, { command: ["sh", "-c", backendStartScript] }),
    [TRAEFIK_DIAGNOSTICS_ID]: servicePlan(TRAEFIK_DIAGNOSTICS_ID, TRAEFIK_DIAGNOSTICS_IMAGE, {
      command: [...TRAEFIK_DIAGNOSTICS_COMMAND],
      mounts: [bindMount(diagnosticDir, TRAEFIK_DIAGNOSTICS_CONTAINER_DIR, true)],
      healthcheck: TRAEFIK_DIAGNOSTICS_HEALTHCHECK,
    }),
    traefik: servicePlan("traefik", TRAEFIK_IMAGE, {
      command: ["sh", "-c", traefikStartScript],
      mounts: [bindMount(dynamicDir, TRAEFIK_DYNAMIC_CONFIG_DIR, false)],
      endpoints: [
        publishedHttp("web", 80, TRAEFIK_WEB_PORT),
        publishedHttp("websecure", 443, TRAEFIK_WEBSECURE_PORT),
      ],
      dependsOn: [
        { service: ServiceName.make(TRAEFIK_DIAGNOSTICS_ID), condition: "service_healthy", required: true },
      ],
    }),
  };
  const plan: AppPlan = {
    id: AppId.make(slug),
    name: slug,
    slug,
    root: AbsolutePath.make(root),
    provider: providerId,
    services,
    routes,
    networks: [],
    networking: landoNetworkingPlan({
      slug,
      serviceNames: Object.keys(services),
      sharedCrossAppNetwork: false,
    }),
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
  const api = makePodmanApiClient(socketPath);
  const stop = async () => {
    await Effect.runPromise(Effect.either(bringDown(plan, { api })));
    await rm(root, { recursive: true, force: true });
  };

  try {
    for (const image of [BACKEND_IMAGE, TRAEFIK_DIAGNOSTICS_IMAGE, TRAEFIK_IMAGE]) {
      await Effect.runPromise(pullImage(api, image));
    }
    const applied = await Effect.runPromise(bringUp(plan, { api }));
    expect(applied.changed).toBe(true);
    await waitForMatchedRoute(matchedHostname, 120_000);
  } catch (error) {
    await stop();
    throw error;
  }
  return { plan, api, matchedHostname, stop };
};

export const expectEmittedConfigPassesNginxTest = async (stack: ProxyDiagnosticsStack): Promise<void> => {
  const result = await Effect.runPromise(
    exec(
      stack.plan,
      { app: stack.plan.id, service: ServiceName.make(TRAEFIK_DIAGNOSTICS_ID) },
      { command: ["nginx", "-t", "-c", `${TRAEFIK_DIAGNOSTICS_CONTAINER_DIR}/nginx.conf`] },
      { api: stack.api },
    ),
  );
  expect(result.stderr, result.stdout).toContain("test is successful");
  expect(result.exitCode).toBe(0);
};
