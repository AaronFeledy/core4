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
  landoAppNetworkName,
} from "@lando/sdk/schema";

const providerId = ProviderId.make("lando");
const webName = ServiceName.make("web");
const dbName = ServiceName.make("db");
const webPort = 31082;
const sourceRoot = AbsolutePath.make("/tmp/lando-forksrc");

interface ContainerInspect {
  readonly Id?: string;
  readonly State?: {
    readonly Running?: boolean;
    readonly Status?: string;
  };
}

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-31T00:00:00Z"),
  source: "scratch-fork-live.integration.test",
  runtime: 4 as const,
};

const webScript = [
  "const http = require('http');",
  "http.createServer((_request, response) => {",
  "  response.end('scratch fork web ready');",
  `}).listen(${webPort}, '0.0.0.0');`,
].join("\n");

const webService = (): ServicePlan => ({
  name: webName,
  type: "compose",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "docker.io/library/node:22-alpine" },
  command: ["node", "-e", webScript],
  environment: { PORT: String(webPort) },
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const postgresService = (): ServicePlan => ({
  name: dbName,
  type: "compose",
  provider: providerId,
  primary: false,
  artifact: { kind: "ref", ref: "docker.io/library/postgres:16-alpine" },
  environment: { POSTGRES_PASSWORD: "lando" },
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const appPlan = (slug: string): AppPlan => {
  const web = webService();
  const db = postgresService();
  return {
    id: AppId.make(slug),
    name: slug,
    slug,
    root: sourceRoot,
    provider: providerId,
    services: { [web.name]: web, [db.name]: db },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const cloneService = (service: ServicePlan): ServicePlan => ({
  ...service,
  environment: { ...service.environment },
  mounts: [...service.mounts],
  storage: [...service.storage],
  endpoints: [...service.endpoints],
  routes: [...service.routes],
  dependsOn: [...service.dependsOn],
  hostAliases: [...service.hostAliases],
  extensions: { ...service.extensions },
});

const requireService = (plan: AppPlan, serviceName: ServiceName): ServicePlan => {
  const service = plan.services[serviceName];
  if (service === undefined) throw new Error(`Missing service ${serviceName} in ${plan.slug}.`);
  return service;
};

const rewritePlanIdentity = (plan: AppPlan, slug: string): AppPlan => {
  const web = cloneService(requireService(plan, webName));
  const db = cloneService(requireService(plan, dbName));
  return {
    ...plan,
    id: AppId.make(slug),
    name: slug,
    slug,
    services: { [web.name]: web, [db.name]: db },
  };
};

const containerName = (plan: AppPlan, service: ServicePlan): string =>
  `lando-${plan.slug}-${service.name}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

const inspectContainers = async (plan: AppPlan, api: ReturnType<typeof makePodmanApiClient>) => {
  const request = api.request;
  if (request === undefined) throw new Error("missing Podman request client");

  return await Promise.all(
    Object.values(plan.services).map(async (service) => {
      const response = await Effect.runPromise(
        request({
          method: "GET",
          path: `/containers/${encodeURIComponent(containerName(plan, service))}/json`,
        }),
      );
      expect(response.status).toBe(200);
      const decoded = JSON.parse(response.body) as ContainerInspect;
      return {
        service: service.name,
        id: decoded.Id,
        running: decoded.State?.Running === true || decoded.State?.Status === "running",
      };
    }),
  );
};

describe("scratch fork app resources — live integration", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "runs a source Node+Postgres app and its scratch fork at the same time",
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath ?? "";
      expect(socketPath).toBeTruthy();

      const api = makePodmanApiClient(socketPath);
      const sourcePlan = appPlan("forksrc");
      const forkPlan = rewritePlanIdentity(sourcePlan, "scratch-forksrc-abc123");

      await Effect.runPromise(Effect.either(bringDown(forkPlan, { podmanApi: api, volumes: true })));
      await Effect.runPromise(Effect.either(bringDown(sourcePlan, { podmanApi: api, volumes: true })));

      try {
        const sourceApplied = await Effect.runPromise(bringUp(sourcePlan, { podmanApi: api }));
        expect(sourceApplied.changed).toBe(true);

        const forkApplied = await Effect.runPromise(bringUp(forkPlan, { podmanApi: api }));
        expect(forkApplied.changed).toBe(true);

        expect(forkPlan.root).toBe(sourcePlan.root);
        expect(landoAppNetworkName(sourcePlan)).toBe("lando-forksrc");
        expect(landoAppNetworkName(forkPlan)).toBe("lando-scratch-forksrc-abc123");
        expect(landoAppNetworkName(sourcePlan)).not.toBe(landoAppNetworkName(forkPlan));

        const sourceContainers = await inspectContainers(sourcePlan, api);
        const forkContainers = await inspectContainers(forkPlan, api);
        expect(sourceContainers.map((container) => container.running)).toEqual([true, true]);
        expect(forkContainers.map((container) => container.running)).toEqual([true, true]);

        const sourceContainerIds = sourceContainers.map((container) => container.id);
        const forkContainerIds = forkContainers.map((container) => container.id);
        expect(new Set(sourceContainerIds).size).toBe(2);
        expect(new Set(forkContainerIds).size).toBe(2);
        for (const containerId of sourceContainerIds) {
          expect(forkContainerIds).not.toContain(containerId);
        }
      } finally {
        await Effect.runPromise(Effect.either(bringDown(forkPlan, { podmanApi: api, volumes: true })));
        await Effect.runPromise(Effect.either(bringDown(sourcePlan, { podmanApi: api, volumes: true })));
      }
    },
    240_000,
  );
});
