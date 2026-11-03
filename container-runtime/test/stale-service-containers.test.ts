import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import { DATA_HELPER_ROLE, ROLE_LABEL } from "../src/labels.ts";
import { commonContainerLabels, serviceContainerName } from "../src/plan.ts";
import { bringDown } from "../src/podman/bring-down.ts";
import { bringUp } from "../src/podman/bring-up.ts";
import {
  type LabeledServiceContainer,
  listLabeledServiceContainers,
  removeStaleServiceContainers,
  selectStaleServiceContainers,
} from "../src/podman/stale-service-containers.ts";

const providerId = ProviderId.make("docker");
const ctx = { providerId: "docker", remediation: "retry", env: {} } as const;
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-11-03T00:00:00Z"),
  source: "container-runtime/stale-service-containers.test.ts",
  runtime: 4 as const,
};

const service = (name: string): ServicePlan => ({
  name: ServiceName.make(name),
  type: "generic",
  provider: providerId,
  primary: name === "web",
  artifact: { kind: "ref", ref: "example/web:latest" },
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const planOf = (slug = "stale-app"): AppPlan => {
  const web = service("web");
  const db = service("db");
  return {
    valueModel: 1,
    id: AppId.make("stale-app"),
    name: "Stale App",
    slug,
    root: AbsolutePath.make("/tmp/stale-app"),
    provider: providerId,
    services: { [web.name]: web, [db.name]: db },
    routes: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const ownedLabels = (
  plan: AppPlan,
  serviceName: string,
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> => ({
  "dev.lando.app": plan.id,
  "dev.lando.app-root": plan.root,
  "dev.lando.service": serviceName,
  ...extra,
});

const labeled = (
  id: string,
  names: ReadonlyArray<string>,
  labels: Readonly<Record<string, string>>,
): LabeledServiceContainer => ({ id, names, labels });

const singleServicePlan = (): AppPlan => {
  const web = service("web");
  return {
    valueModel: 1,
    id: AppId.make("stale-app"),
    name: "Stale App",
    slug: "stale-app",
    root: AbsolutePath.make("/tmp/stale-app"),
    provider: providerId,
    services: { [web.name]: web },
    routes: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const runningInspect = (plan: AppPlan, serviceName: string, id: string): EngineHttpResponse => {
  const svc = plan.services[ServiceName.make(serviceName)];
  if (svc === undefined) throw new Error(`missing ${serviceName}`);
  return {
    status: 200,
    body: JSON.stringify({
      Id: id,
      State: { Running: true },
      Config: { Labels: commonContainerLabels(plan, svc) },
    }),
  };
};

describe("selectStaleServiceContainers", () => {
  test("selects owned plan-service containers whose name is not the planned name", () => {
    const plan = planOf();
    const expectedWeb = serviceContainerName(plan, "web");
    const selected = selectStaleServiceContainers(plan, ctx.providerId, [
      labeled("stale-web", ["lando-stale-app-web-old"], ownedLabels(plan, "web")),
      labeled("current-web", [expectedWeb], ownedLabels(plan, "web")),
      labeled("stale-db", ["/lando-stale-app-db-legacy"], ownedLabels(plan, "db")),
    ]);
    expect(selected).toEqual([
      { containerId: "stale-web", service: "web", name: "lando-stale-app-web-old" },
      { containerId: "stale-db", service: "db", name: "lando-stale-app-db-legacy" },
    ]);
  });

  test("excludes foreign ownership, role-labeled helpers, and non-plan services", () => {
    const plan = planOf();
    const selected = selectStaleServiceContainers(plan, ctx.providerId, [
      labeled("foreign-app", ["other-web"], {
        "dev.lando.app": "other",
        "dev.lando.app-root": plan.root,
        "dev.lando.service": "web",
      }),
      labeled("foreign-root", ["root-web"], {
        "dev.lando.app": plan.id,
        "dev.lando.app-root": "/tmp/other-root",
        "dev.lando.service": "web",
      }),
      labeled("foreign-provider", ["prov-web"], {
        "dev.lando.app": plan.id,
        "dev.lando.app-root": plan.root,
        "dev.lando.service": "web",
        "dev.lando.provider": "podman",
      }),
      labeled("helper", ["helper-1"], {
        ...ownedLabels(plan, "web"),
        [ROLE_LABEL]: DATA_HELPER_ROLE,
      }),
      labeled("orphan-service", ["orphan"], ownedLabels(plan, "cache")),
      labeled("unknown-name", [], ownedLabels(plan, "web")),
      labeled("incoherent", ["no-service-label"], {
        "dev.lando.app": plan.id,
        "dev.lando.app-root": plan.root,
      }),
    ]);
    expect(selected).toEqual([]);
  });
});

const listBody = (containers: ReadonlyArray<Record<string, unknown>>) => JSON.stringify(containers);

const makeApi = (handlers: {
  readonly list?: ReadonlyArray<Record<string, unknown>>;
  readonly inspect?: (name: string) => EngineHttpResponse | undefined;
  readonly onRequest?: (request: EngineHttpRequest) => EngineHttpResponse | undefined;
}) => {
  const calls: EngineHttpRequest[] = [];
  const api = {
    request: (request: EngineHttpRequest) =>
      Effect.sync((): EngineHttpResponse => {
        calls.push(request);
        const custom = handlers.onRequest?.(request);
        if (custom !== undefined) return custom;
        if (request.method === "GET" && request.path.startsWith("/containers/json?")) {
          return { status: 200, body: listBody(handlers.list ?? []) };
        }
        if (request.method === "GET" && request.path.startsWith("/networks/")) {
          return { status: 404, body: "{}" };
        }
        if (request.method === "POST" && request.path.includes("/networks/create")) {
          return { status: 201, body: "{}" };
        }
        const match = request.path.match(/^\/containers\/([^/?]+)(?:\/([^?]+))?/u);
        const name = match === null ? "" : decodeURIComponent(match[1] ?? "");
        const action = match?.[2];
        if (request.method === "GET" && action === "json") {
          return handlers.inspect?.(name) ?? { status: 404, body: "{}" };
        }
        if (request.method === "POST" && action === "stop") return { status: 204, body: "" };
        if (request.method === "DELETE" && request.path.startsWith("/containers/")) {
          return { status: 204, body: "" };
        }
        if (request.method === "POST" && request.path.startsWith("/containers/create")) {
          return { status: 201, body: "{}" };
        }
        if (request.method === "POST" && action === "start") return { status: 204, body: "" };
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
  };
  return { api, calls };
};

describe("bringUp stale-name convergence", () => {
  test("removes stale owned containers once before creation", async () => {
    // Given an old owned container alongside containers this apply must leave alone.
    const plan = planOf();
    const expectedWeb = serviceContainerName(plan, "web");
    const expectedDb = serviceContainerName(plan, "db");
    let dbCreated = false;
    const fake = makeApi({
      list: [
        {
          Id: "stale-id",
          Names: ["/lando-stale-app-web-old"],
          Labels: ownedLabels(plan, "web"),
        },
        {
          Id: "helper-id",
          Names: ["/helper"],
          Labels: { ...ownedLabels(plan, "web"), [ROLE_LABEL]: DATA_HELPER_ROLE },
        },
        {
          Id: "foreign-root-id",
          Names: ["/lando-stale-app-web"],
          Labels: ownedLabels(plan, "web", { "dev.lando.app-root": "/tmp/another-worktree" }),
        },
        {
          Id: "unselected-id",
          Names: ["/lando-stale-app-cache"],
          Labels: ownedLabels(plan, "cache"),
        },
      ],
      inspect: (name) => {
        if (name === expectedWeb) return runningInspect(plan, "web", "id-web");
        if (name === expectedDb && dbCreated) return runningInspect(plan, "db", "id-db");
        return { status: 404, body: "{}" };
      },
      onRequest: (request) => {
        if (request.method === "POST" && request.path.startsWith("/containers/create?")) {
          dbCreated = true;
          return { status: 201, body: "{}" };
        }
        if (request.path === "/containers/stale-id/json") {
          return {
            status: 200,
            body: JSON.stringify({ State: { Status: "exited", ExitCode: 0, OOMKilled: false } }),
          };
        }
        return undefined;
      },
    });
    // When
    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));
    // Then cleanup precedes creation and never mutates the other containers.
    expect(result.changed).toBe(true);
    const listCalls = fake.calls.filter((call) => call.path.startsWith("/containers/json?"));
    expect(listCalls).toHaveLength(1);
    expect(
      fake.calls
        .filter((call) => call.path.includes("stale-id"))
        .map((call) => `${call.method} ${call.path}`),
    ).toEqual([
      "POST /containers/stale-id/stop",
      "GET /containers/stale-id/json",
      "DELETE /containers/stale-id?force=true&v=true",
    ]);
    expect(fake.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      "/containers/stale-id?force=true&v=true",
    ]);
    const firstCreate = fake.calls.findIndex(
      (call) => call.method === "POST" && call.path.startsWith("/containers/create?"),
    );
    expect(firstCreate).toBeGreaterThan(fake.calls.findIndex((call) => call.method === "DELETE"));
    expect(dbCreated).toBe(true);
  });

  test("does not sweep stale containers when forbidRecreate is set", async () => {
    // Given an owned old-named container and an already running planned container.
    const plan = singleServicePlan();
    const expected = serviceContainerName(plan, "web");
    const fake = makeApi({
      list: [
        {
          Id: "stale-id",
          Names: ["/lando-stale-app-web-old"],
          Labels: ownedLabels(plan, "web"),
        },
      ],
      inspect: (name) =>
        name === expected ? runningInspect(plan, "web", "current") : { status: 404, body: "{}" },
      onRequest: (request) => {
        if (request.path === "/containers/stale-id/json") {
          return {
            status: 200,
            body: JSON.stringify({ State: { Status: "exited", ExitCode: 0, OOMKilled: false } }),
          };
        }
        return undefined;
      },
    });
    // When
    await Effect.runPromise(bringUp(plan, { api: fake.api, ctx, forbidRecreate: true }));
    // Then restart neither discovers nor mutates stale containers.
    expect(
      fake.calls
        .filter((call) => call.path.startsWith("/containers/"))
        .every((call) => call.method === "GET"),
    ).toBe(true);
    expect(fake.calls.filter((call) => call.path.startsWith("/containers/json?"))).toEqual([]);
  });
});

describe("bringDown stale-name sweep", () => {
  test("whole-app stop removes owned alternate-named containers by id with v=true", async () => {
    // Given an old owned container and no current-name containers.
    const plan = planOf();
    const expectedWeb = serviceContainerName(plan, "web");
    const expectedDb = serviceContainerName(plan, "db");
    const fake = makeApi({
      list: [
        {
          Id: "stale-web-id",
          Names: ["/lando-stale-app-web-old"],
          Labels: ownedLabels(plan, "web"),
        },
      ],
      inspect: (name) => {
        if (name === expectedWeb || name === expectedDb) return { status: 404, body: "{}" };
        return { status: 404, body: "{}" };
      },
      onRequest: (request) => {
        if (request.path === "/containers/stale-web-id/json") {
          return {
            status: 200,
            body: JSON.stringify({
              State: { Status: "exited", ExitCode: 0, OOMKilled: false },
            }),
          };
        }
        return undefined;
      },
    });
    // When
    const result = await Effect.runPromise(bringDown(plan, { api: fake.api, ctx }));
    // Then stop removes the old container and its anonymous volumes.
    expect(result.changed).toBe(true);
    expect(
      fake.calls
        .filter((call) => call.path.includes("stale-web-id"))
        .map((call) => `${call.method} ${call.path}`),
    ).toEqual([
      "POST /containers/stale-web-id/stop",
      "GET /containers/stale-web-id/json",
      "DELETE /containers/stale-web-id?force=true&v=true",
    ]);
    const listCalls = fake.calls.filter((call) => call.path.startsWith("/containers/json?"));
    expect(listCalls).toHaveLength(1);
  });
});

describe("list and alternate helpers", () => {
  test("listLabeledServiceContainers keeps names and filters to app-labeled rows", async () => {
    const fake = makeApi({
      list: [
        {
          Id: "a",
          Names: ["/one"],
          Labels: { "dev.lando.app": "stale-app", "dev.lando.service": "web" },
        },
        { Id: "b", Names: ["/two"], Labels: {} },
      ],
    });
    const listed = await Effect.runPromise(listLabeledServiceContainers(fake.api, ctx, "stale-app"));
    expect(fake.calls.map((call) => decodeURIComponent(call.path))).toEqual([
      '/containers/json?all=true&filters={"label":["dev.lando.app=stale-app"]}',
    ]);
    expect(listed).toEqual([
      {
        id: "a",
        names: ["one"],
        labels: { "dev.lando.app": "stale-app", "dev.lando.service": "web" },
      },
    ]);
  });

  test("removeStaleServiceContainers is a no-op for an empty selection", async () => {
    const plan = planOf();
    const fake = makeApi({});
    const changed = await Effect.runPromise(removeStaleServiceContainers(fake.api, ctx, plan, []));
    expect(changed).toBe(false);
    expect(fake.calls).toEqual([]);
  });
});
