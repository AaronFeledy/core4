import { AppPlan, landoNetworkingPlan } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import type { EngineHttpApi, EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import { networkOwnershipLabels } from "../src/native-ownership.ts";
import { commonContainerLabels } from "../src/plan.ts";

export const networkPlan = Schema.decodeUnknownSync(AppPlan)({
  valueModel: 1,
  id: "networks",
  name: "Networks",
  slug: "networks",
  root: "/tmp/networks",
  provider: "docker",
  services: Object.fromEntries(
    ["web", "worker"].map((name) => [
      name,
      {
        name,
        type: "generic",
        provider: "docker",
        primary: name === "web",
        artifact: { kind: "ref", ref: "example/web:latest" },
        environment: {},
        mounts: [],
        storage: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        extensions: {},
        metadata: { runtime: 4, resolvedAt: "2026-10-25T00:00:00Z", source: "test" },
      },
    ]),
  ),
  routes: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata: { runtime: 4, resolvedAt: "2026-10-25T00:00:00Z", source: "test" },
  networking: landoNetworkingPlan({
    slug: "networks",
    serviceNames: ["web", "worker"],
    sharedCrossAppNetwork: true,
    bridgeAliases: { web: ["frontend"] },
    authoredNetworks: [
      { key: "private", external: false, driver: "macvlan", members: { web: ["private-web"] } },
      { key: "sibling", external: true, name: "sibling net", members: { web: ["public-web"] } },
    ],
  }),
});

export const networkApi = (
  options: {
    readonly inspect?: (name: string) => EngineHttpResponse | undefined;
    readonly existing?: boolean;
    readonly connectStatus?: number;
    readonly conflict?: boolean;
    readonly retryStart?: boolean;
  } = {},
) => {
  const requests: EngineHttpRequest[] = [];
  const containers = new Map<string, unknown>();
  const owned = {
    Name: "lando-networks_private",
    Driver: "macvlan",
    Labels: networkOwnershipLabels(networkPlan),
  };
  if (options.existing) {
    for (const service of Object.values(networkPlan.services))
      containers.set(`lando-networks-${service.name}`, {
        Id: `id-${service.name}`,
        Config: { Labels: commonContainerLabels(networkPlan, service) },
        State: { Running: true },
      });
  }
  let startRetried = false;
  const api: EngineHttpApi = {
    request: (request) =>
      Effect.sync((): EngineHttpResponse => {
        requests.push(request);
        if (request.method === "GET" && request.path.startsWith("/networks/")) {
          const name = decodeURIComponent(request.path.slice("/networks/".length));
          return (
            options.inspect?.(name) ?? {
              status: 200,
              body: JSON.stringify(name === owned.Name ? owned : { Name: name }),
            }
          );
        }
        if (["/networks/create", "/libpod/networks/create"].includes(request.path))
          return { status: options.conflict ? 409 : 201, body: "{}" };
        if (request.path.endsWith("/connect"))
          return { status: options.connectStatus ?? 200, body: '{"message":"already connected"}' };
        if (request.path.startsWith("/containers/create?")) {
          const name = new URL(`http://engine${request.path}`).searchParams.get("name") ?? "";
          containers.set(name, {
            Id: name,
            Config: { Labels: field(request.body, "Labels") },
            State: { Running: true },
          });
          return { status: 201, body: "{}" };
        }
        const match = /^\/containers\/([^/?]+)(?:\/(json|start|stop))?/u.exec(request.path);
        const name = decodeURIComponent(match?.[1] ?? "");
        if (request.method === "GET") {
          const body = containers.get(name);
          return body === undefined
            ? { status: 404, body: "{}" }
            : { status: 200, body: JSON.stringify(body) };
        }
        if (match?.[2] === "start" && options.retryStart && !startRetried) {
          startRetried = true;
          return { status: 500, body: '{"message":"address already in use"}' };
        }
        if (request.method === "DELETE") containers.delete(name);
        return { status: 204, body: "" };
      }),
  };
  return { api, requests };
};

export const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
