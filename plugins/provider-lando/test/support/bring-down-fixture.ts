import { DateTime, Effect, Schema } from "effect";

import type {
  EngineHttpRequest,
  EngineHttpResponse,
  PodmanApiClient,
} from "@lando/container-runtime/engine-api";
import { volumeSelectorValue } from "@lando/container-runtime/podman/volume-prune";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
  appIdentityKey,
} from "@lando/sdk/schema";
import { decodeNetworkCreate } from "../network-fixture.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("bringdownapp");
export const appRoot = AbsolutePath.make("/tmp/lando-bringdown-app");
/** The selector the writer produces for this fixture root, derived the way production derives it. */
export const volumeSelector = (id: string, volumeClass: "cache" | "data"): string =>
  volumeSelectorValue({ providerId, appId: id, ownerKey: appIdentityKey("owner", appRoot), volumeClass });
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-14T00:00:00Z"),
  source: "bring-down.integration.test",
  runtime: 4 as const,
};

export const servicePlan = (name: "node" | "database"): ServicePlan => ({
  name: ServiceName.make(name),
  type: name === "node" ? "node" : "postgres",
  provider: providerId,
  primary: name === "node",
  artifact: { kind: "ref", ref: name === "node" ? "node:22-alpine" : "postgres:16-alpine" },
  command: name === "node" ? ["node", "-e", "setInterval(() => {}, 1000)"] : ["postgres", "-c", "port=55432"],
  environment: name === "node" ? {} : { POSTGRES_PASSWORD: "lando", POSTGRES_DB: "lando" },
  mounts:
    name === "node"
      ? [
          {
            type: "bind",
            role: "app",
            source: appRoot,
            target: PortablePath.make("/app"),
            readOnly: false,
            excludes: [],
            includes: [],
            realization: "passthrough",
          },
        ]
      : name === "database"
        ? [
            {
              type: "volume",
              store: "bringdownapp_database_data",
              target: PortablePath.make("/var/lib/postgresql/data"),
              readOnly: false,
            },
          ]
        : [],
  endpoints:
    name === "node"
      ? [
          {
            _tag: "published",
            port: 31081,
            protocol: "http",
            name: "http",
            publication: { bindAddress: "127.0.0.1", hostPort: 31081 },
          },
        ]
      : [{ _tag: "internal", port: 55433, protocol: "tcp", name: "database" }],
  routes: [],
  dependsOn:
    name === "node"
      ? [{ service: ServiceName.make("database"), condition: "service_started", required: true }]
      : [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const database = servicePlan("database");
const node = servicePlan("node");

export const plan: AppPlan = {
  valueModel: 1,
  id: appId,
  name: "BringDown App",
  slug: "bringdownapp",
  root: appRoot,
  provider: providerId,
  services: { [database.name]: database, [node.name]: node },
  routes: [],
  stores: [
    { name: "bringdownapp_database_data", scope: "app", kind: "data" },
    { name: "lando-cache-npm", scope: "global", kind: "cache", key: "npm" },
  ],
  fileSync: [],
  metadata,
  extensions: {},
};

const decodeCreateBody = Schema.decodeUnknownSync(
  Schema.Struct({
    Name: Schema.optional(Schema.String),
    Labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);

export const makeFakeApi = () => {
  const running = new Set<string>();
  const existing = new Set<string>();
  const networks = new Set<string>();
  const containers = new Map<
    string,
    { readonly Id: string; readonly Labels: Readonly<Record<string, string>> }
  >();
  const networkDetails = new Map<
    string,
    {
      readonly Id: string;
      readonly Name: string;
      readonly Driver: string;
      readonly Labels?: Readonly<Record<string, string>>;
    }
  >();
  const volumes = new Set<string>(plan.stores.map((store) => store.name));
  const volumeLabels = new Map<string, Readonly<Record<string, string>>>(
    plan.stores.map((store) => [
      store.name,
      {
        "dev.lando.volume-selector": volumeSelector(plan.id, store.kind === "cache" ? "cache" : "data"),
      },
    ]),
  );
  const calls: EngineHttpRequest[] = [];
  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.sync((): EngineHttpResponse => {
        calls.push(request);
        const containerMatch = request.path.match(/^\/containers\/([^/?]+)(?:\/([^?]+))?/u);
        const reference = containerMatch === null ? "" : decodeURIComponent(containerMatch[1] ?? "");
        const name = [...containers].find(([, container]) => container.Id === reference)?.[0] ?? reference;
        const action = containerMatch?.[2];

        const networkCreate = decodeNetworkCreate(request);
        if (networkCreate !== undefined) {
          const requestedName = networkCreate.Name;
          networks.add(requestedName);
          const network = { Id: `${requestedName}-id`, ...networkCreate };
          networkDetails.set(requestedName, network);
          return { status: 201, body: JSON.stringify(network) };
        }
        if (request.path === "/volumes/create") {
          const body = request.body as { Name?: string; Labels?: Readonly<Record<string, string>> };
          const requestedName = body.Name ?? "";
          const existed = volumes.has(requestedName);
          volumes.add(requestedName);
          if (!existed && body.Labels !== undefined) volumeLabels.set(requestedName, body.Labels);
          return { status: existed ? 409 : 201, body: "{}" };
        }
        if (request.method === "GET" && request.path.startsWith("/networks/")) {
          const reference = decodeURIComponent(request.path.slice("/networks/".length));
          const name = [...networkDetails].find(([, network]) => network.Id === reference)?.[0] ?? reference;
          const network = networkDetails.get(name);
          return { status: network === undefined ? 404 : 200, body: JSON.stringify(network ?? {}) };
        }
        if (request.method === "DELETE" && request.path.startsWith("/networks/")) {
          const reference = decodeURIComponent(request.path.slice("/networks/".length));
          const name = [...networkDetails].find(([, network]) => network.Id === reference)?.[0] ?? reference;
          const deleted = networks.delete(name);
          networkDetails.delete(name);
          return { status: deleted ? 204 : 404, body: "" };
        }
        if (request.method === "GET" && action === "json") {
          if (!existing.has(name)) {
            return { status: 404, body: "{}" };
          }
          return {
            status: 200,
            body: JSON.stringify({
              Id: containers.get(name)?.Id,
              Config: { Labels: containers.get(name)?.Labels },
              State: { Running: running.has(name), Status: running.has(name) ? "running" : "created" },
            }),
          };
        }
        if (request.method === "POST" && request.path.startsWith("/containers/create")) {
          const createdName = new URL(`http://localhost${request.path}`).searchParams.get("name") ?? "";
          if (existing.has(createdName)) {
            return { status: 409, body: "already exists" };
          }
          existing.add(createdName);
          const body = decodeCreateBody(request.body);
          const container = { Id: `${createdName}-id`, Labels: body.Labels ?? {} };
          containers.set(createdName, container);
          return { status: 201, body: JSON.stringify(container) };
        }
        if (request.method === "POST" && action === "start") {
          running.add(name);
          return { status: 204, body: "" };
        }
        if (request.method === "POST" && action === "stop") {
          if (!existing.has(name)) {
            return { status: 404, body: "" };
          }
          const stopped = running.delete(name);
          return { status: stopped ? 204 : 304, body: "" };
        }
        if (request.method === "DELETE" && request.path.startsWith("/containers/")) {
          const deleted = existing.delete(name);
          running.delete(name);
          containers.delete(name);
          return { status: deleted ? 204 : 404, body: "" };
        }
        if (request.method === "GET" && request.path.startsWith("/volumes/")) {
          const volume = decodeURIComponent(request.path.slice("/volumes/".length).replace(/\/json$/u, ""));
          return {
            status: volumes.has(volume) ? 200 : 404,
            body: JSON.stringify({ Labels: volumeLabels.get(volume) ?? {} }),
          };
        }
        if (request.method === "DELETE" && request.path.startsWith("/volumes/")) {
          const volume = decodeURIComponent(request.path.slice("/volumes/".length));
          const deleted = volumes.delete(volume);
          volumeLabels.delete(volume);
          return { status: deleted ? 204 : 404, body: "" };
        }
        if (request.method === "POST" && request.path.startsWith("/libpod/volumes/prune")) {
          return { status: 200, body: "[]" };
        }
        if (request.method === "GET" && request.path.startsWith("/containers/json?")) {
          return { status: 200, body: "[]" };
        }
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
  };
  return { api, calls, existing, networks, volumes };
};
