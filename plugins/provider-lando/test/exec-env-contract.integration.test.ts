import { describe, expect, test } from "bun:test";
import { Effect, Schema, Stream } from "effect";

import { bringUp, exec } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LandofileShape,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { ServiceTypeHostFacts } from "@lando/sdk/services";
import { nodeLtsServiceType } from "@lando/service-lando";
import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "../src/capabilities.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const host: ServiceTypeHostFacts = {
  os: "linux",
  user: "alpha-tester",
  uid: "1000",
  gid: "1000",
  home: "/home/alpha-tester",
};

const planNodeService = (): ServicePlan => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "envapp",
    services: { web: { type: "node:lts" } },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return nodeLtsServiceType.__legacyToServicePlan({
    name: "web",
    service,
    appRoot: "/srv/apps/envapp",
    appName: "envapp",
    metadata,
    host,
  });
};

const buildPlan = (servicePlan: ServicePlan): AppPlan => ({
  id: AppId.make("envapp"),
  name: "envapp",
  slug: "envapp",
  root: AbsolutePath.make("/srv/apps/envapp"),
  provider: ProviderId.make("lando"),
  services: { [servicePlan.name]: servicePlan },
  routes: [],
  networks: [],
  stores: [],
  metadata: { ...metadata, source: "/srv/apps/envapp/.lando.yml" },
  extensions: {},
});

const containerName = (slug: string, service: string) =>
  `lando-${slug}-${service}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

const makeFakeApi = () => {
  const calls: PodmanHttpRequest[] = [];
  const created = new Set<string>();
  const networks = new Set<string>();

  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    request: (request) =>
      Effect.sync((): PodmanHttpResponse => {
        calls.push(request);

        if (request.path === "/networks/create") {
          networks.add((request.body as { Name?: string }).Name ?? "");
          return { status: 201, body: "{}" };
        }
        if (request.method === "DELETE" && request.path.startsWith("/networks/")) {
          return { status: 204, body: "" };
        }
        if (request.method === "GET" && request.path === "/exec/exec-1/json") {
          return { status: 200, body: JSON.stringify({ ExitCode: 0 }) };
        }
        if (
          request.method === "GET" &&
          request.path.startsWith("/containers/") &&
          request.path.endsWith("/json")
        ) {
          const containerMatch = request.path.match(/^\/containers\/([^/]+)\/json/u);
          if (containerMatch === null) {
            return { status: 500, body: "bad json route" };
          }
          const name = decodeURIComponent(containerMatch[1] ?? "");
          if (!created.has(name)) {
            return { status: 404, body: "" };
          }
          return {
            status: 200,
            body: JSON.stringify({ State: { Running: true, Status: "running" } }),
          };
        }
        if (request.method === "POST" && request.path.startsWith("/containers/create")) {
          const createdName = new URL(`http://localhost${request.path}`).searchParams.get("name") ?? "";
          created.add(createdName);
          return { status: 201, body: "{}" };
        }
        if (
          request.method === "POST" &&
          request.path.startsWith("/containers/") &&
          request.path.endsWith("/exec")
        ) {
          return { status: 201, body: JSON.stringify({ Id: "exec-1" }) };
        }
        if (request.method === "POST" && request.path.endsWith("/start")) {
          return { status: 204, body: "" };
        }
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
    stream: (request) => {
      calls.push(request);
      return Stream.empty;
    },
  };

  return { api, calls };
};

describe("provider-lando exec env contract", () => {
  test("plan.environment from service-lando is wired into the container Env at create time so exec inherits it", async () => {
    const servicePlan = planNodeService();
    const plan = buildPlan(servicePlan);
    const fake = makeFakeApi();

    await Effect.runPromise(bringUp(plan, { podmanApi: fake.api }));

    const createCall = fake.calls.find(
      (call) =>
        call.method === "POST" &&
        call.path.startsWith("/containers/create") &&
        new URL(`http://localhost${call.path}`).searchParams.get("name") ===
          containerName(plan.slug, String(servicePlan.name)),
    );
    expect(createCall).toBeDefined();
    const envArray = (createCall?.body as { Env?: ReadonlyArray<string> } | undefined)?.Env ?? [];
    const envMap = new Map(envArray.map((entry) => entry.split("=", 2) as [string, string]));

    expect(envMap.get("LANDO")).toBe("ON");
    expect(envMap.get("LANDO_APP_NAME")).toBe("envapp");
    expect(envMap.get("LANDO_PROJECT")).toBe("envapp");
    expect(envMap.get("LANDO_APP_KIND")).toBe("user");
    expect(envMap.get("LANDO_APP_ROOT")).toBe("/app");
    expect(envMap.get("LANDO_PROJECT_MOUNT")).toBe("/app");
    expect(envMap.get("LANDO_SERVICE_API")).toBe("4");
    expect(envMap.get("LANDO_SERVICE_NAME")).toBe("web");
    expect(envMap.get("LANDO_SERVICE_TYPE")).toBe("node:lts");
    expect(envMap.get("LANDO_HOST_OS")).toBe(host.os);
    expect(envMap.get("LANDO_HOST_USER")).toBe(host.user);
    expect(envMap.get("LANDO_HOST_UID")).toBe(host.uid);
    expect(envMap.get("LANDO_HOST_GID")).toBe(host.gid);
    expect(envMap.get("LANDO_HOST_HOME")).toBe(host.home);
  });

  test("exec propagates command.env so tooling-supplied LANDO_* values reach the executed command", async () => {
    const servicePlan = planNodeService();
    const plan = buildPlan(servicePlan);
    const fake = makeFakeApi();

    await Effect.runPromise(bringUp(plan, { podmanApi: fake.api }));

    const commandEnv: Record<string, string> = {
      LANDO_PLUGIN_TOOLING_VAR: "ok",
      LANDO_APP_NAME: servicePlan.environment.LANDO_APP_NAME ?? "envapp",
    };

    await Effect.runPromise(
      exec(
        plan,
        { app: plan.id, service: servicePlan.name },
        { command: ["printenv", "LANDO_PLUGIN_TOOLING_VAR"], env: commandEnv },
        { podmanApi: fake.api },
      ),
    );

    const execCreate = fake.calls.find((call) => call.method === "POST" && call.path.endsWith("/exec"));
    expect(execCreate).toBeDefined();
    const execBody = execCreate?.body as { Env?: ReadonlyArray<string> } | undefined;
    expect(execBody?.Env).toContain("LANDO_PLUGIN_TOOLING_VAR=ok");
    expect(execBody?.Env).toContain("LANDO_APP_NAME=envapp");
  });
});
