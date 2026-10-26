import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";
import type { EngineHttpApi, EngineHttpRequest, EngineHttpResponse } from "../../src/engine-api.ts";
import { commonContainerLabels } from "../../src/plan.ts";

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-10-23T00:00:00Z"),
  source: "test",
  runtime: 4 as const,
};
export const service: ServicePlan = {
  name: ServiceName.make("web"),
  type: "web",
  provider: ProviderId.make("docker"),
  primary: true,
  artifact: { kind: "ref", ref: "nginx:1.27-alpine" },
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};
export const plan: AppPlan = {
  valueModel: 1,
  id: AppId.make("values"),
  name: "values",
  slug: "values",
  root: AbsolutePath.make("/tmp/lando-values"),
  provider: service.provider,
  services: { [service.name]: service },
  networks: [],
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};
export const withService = (value: ServicePlan): AppPlan => ({ ...plan, services: { [value.name]: value } });
export const legacyPlan = (): AppPlan => {
  const { valueModel: _marker, ...legacy } = plan;
  return legacy;
};
export const ctx = { providerId: "docker", remediation: "Retry.", env: {} };

export const fakeEngine = (existing?: AppPlan, initiallyRunning = true) => {
  const calls: EngineHttpRequest[] = [];
  let exists = existing !== undefined;
  let running = initiallyRunning;
  let labels = commonContainerLabels(existing ?? plan, existing?.services[service.name] ?? service);
  const api: EngineHttpApi = {
    request: (request) =>
      Effect.sync((): EngineHttpResponse => {
        calls.push(request);
        if (request.method === "GET" && request.path.endsWith("/json")) {
          return exists
            ? {
                status: 200,
                body: JSON.stringify({
                  Id: "owned-id",
                  State: { Running: running },
                  Config: { Labels: labels },
                }),
              }
            : { status: 404, body: "{}" };
        }
        if (request.path.startsWith("/networks/")) return { status: 200, body: "{}" };
        if (request.method === "DELETE") {
          exists = false;
          return { status: 204, body: "" };
        }
        if (request.path.startsWith("/containers/create?")) {
          exists = true;
          if (typeof request.body === "object" && request.body !== null && "Labels" in request.body) {
            const value = request.body.Labels;
            if (typeof value === "object" && value !== null) {
              labels = Object.fromEntries(
                Object.entries(value).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string",
                ),
              );
            }
          }
          return { status: 201, body: "{}" };
        }
        if (request.path.endsWith("/start")) running = true;
        if (request.path.endsWith("/stop")) running = false;
        return { status: 204, body: "" };
      }),
  };
  return { api, calls, mutations: () => calls.filter((call) => call.method !== "GET") };
};
