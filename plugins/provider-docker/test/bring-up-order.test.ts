import { describe, expect, test } from "bun:test";
import { Cause, DateTime, Effect, Exit, Stream } from "effect";

import { type DockerApiClient, type DockerHttpResponse, makeRuntimeProvider } from "@lando/provider-docker";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServicePlan } from "@lando/sdk/schema";

const providerId = ProviderId.make("docker");
const appId = AppId.make("bring-up-order-app");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-26T00:00:00Z"),
  source: "provider-docker/bring-up-order.test.ts",
  runtime: 4 as const,
};

const service = (name: string, options: Pick<ServicePlan, "dependsOn" | "healthcheck">): ServicePlan => ({
  name: ServiceName.make(name),
  type: "test",
  provider: providerId,
  primary: name === "web",
  artifact: { kind: "ref", ref: "alpine:3.22" },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: options.dependsOn,
  ...(options.healthcheck === undefined ? {} : { healthcheck: options.healthcheck }),
  hostAliases: [],
  metadata,
  extensions: {},
});

const healthyDb = service("db", {
  dependsOn: [],
  healthcheck: {
    kind: "command",
    command: ["pg_isready"],
    intervalSeconds: 0,
    timeoutSeconds: 5,
    retries: 1,
  },
});

const planWith = (services: ReadonlyArray<ServicePlan>): AppPlan => ({
  id: appId,
  name: "Bring Up Order App",
  slug: "bring-up-order-app",
  root: AbsolutePath.make("/tmp/bring-up-order-app"),
  provider: providerId,
  services: Object.fromEntries(services.map((entry) => [entry.name, entry])),
  routes: [],
  networks: [],
  networking: { perAppBridge: { name: "lando-bring-up-order-app", driver: "bridge" } },
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

const makeFakeApi = (
  healthExitCode: number,
  existing: ReadonlyArray<string> = [],
  failedStarts: ReadonlyArray<string> = [],
) => {
  const requests: string[] = [];
  const existingNames = new Set(existing);
  const failedStartNames = new Set(failedStarts);
  const images = new Set<string>();
  const responseFor = (method: string, path: string): DockerHttpResponse => {
    if (path === "/networks/create") return { status: 201, body: "" };
    if (method === "GET" && path.startsWith("/images/") && path.endsWith("/json")) {
      const ref = decodeURIComponent(path.slice("/images/".length, -"/json".length));
      return images.has(ref)
        ? { status: 200, body: '{"Id":"sha256:test"}' }
        : { status: 404, body: '{"message":"No such image"}' };
    }
    if (method === "POST" && path.startsWith("/images/create?")) {
      const params = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      const fromImage = params.get("fromImage") ?? "";
      const tag = params.get("tag") ?? "";
      if (fromImage.length > 0) {
        images.add(fromImage);
        if (tag.length > 0) {
          images.add(`${fromImage}:${tag}`);
          images.add(`${fromImage}@${tag}`);
        }
      }
      return { status: 200, body: '{"status":"Pull complete"}\n' };
    }
    if (method === "GET" && path.startsWith("/containers/") && path.endsWith("/json")) {
      const name = path.slice("/containers/".length, -"/json".length);
      return existingNames.has(name)
        ? { status: 200, body: '{"State":{"Running":false}}' }
        : { status: 404, body: "" };
    }
    if (path.startsWith("/containers/create?")) return { status: 201, body: "" };
    if (path.endsWith("/start")) {
      const name = path.slice("/containers/".length, -"/start".length);
      return failedStartNames.has(name)
        ? { status: 500, body: '{"message":"synthetic start failure"}' }
        : { status: 204, body: "" };
    }
    if (method === "POST" && path.endsWith("/exec")) return { status: 201, body: '{"Id":"health"}' };
    if (path === "/exec/health/json") {
      return { status: 200, body: JSON.stringify({ ExitCode: healthExitCode }) };
    }
    if (path.endsWith("/stop")) return { status: 204, body: "" };
    if (method === "DELETE") return { status: 204, body: "" };
    return { status: 500, body: '{"message":"unexpected request"}' };
  };
  const api: DockerApiClient = {
    info: Effect.succeed({}),
    request: ({ method, path }) => {
      requests.push(`${method} ${path}`);
      return Effect.succeed(responseFor(method, path));
    },
    stream: ({ method, path }) => {
      requests.push(`${method} ${path}`);
      return Stream.empty;
    },
  };
  return { api, requests };
};

const apply = async (plan: AppPlan, api: DockerApiClient, signal?: AbortSignal) => {
  const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: api }));
  return Effect.runPromise(
    Effect.scoped(provider.apply(plan, { reconcile: false, ...(signal === undefined ? {} : { signal }) })),
  );
};

const applyFailure = async (plan: AppPlan, api: DockerApiClient) => {
  const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: api }));
  return Effect.runPromise(Effect.flip(Effect.scoped(provider.apply(plan, { reconcile: false }))));
};

describe("provider-docker bringUp dependency order", () => {
  test("starts a service_healthy dependency and probes it before starting the dependent", async () => {
    // Given
    const web = service("web", {
      dependsOn: [{ service: healthyDb.name, condition: "service_healthy", required: true }],
      healthcheck: undefined,
    });
    const plan = planWith([web, healthyDb]);
    const fake = makeFakeApi(0);

    // When
    await apply(plan, fake.api);

    // Then
    const dbStart = fake.requests.indexOf("POST /containers/lando-bring-up-order-app-db/start");
    const dbExec = fake.requests.indexOf("POST /containers/lando-bring-up-order-app-db/exec");
    const webStart = fake.requests.indexOf("POST /containers/lando-bring-up-order-app-web/start");
    expect(dbStart).toBeGreaterThan(-1);
    expect(dbExec).toBeGreaterThan(dbStart);
    expect(webStart).toBeGreaterThan(dbExec);
  });

  test("fails naming the unmet gate and rolls back when a required gate fails", async () => {
    // Given
    const web = service("web", {
      dependsOn: [{ service: healthyDb.name, condition: "service_healthy", required: true }],
      healthcheck: undefined,
    });
    const plan = planWith([web, healthyDb]);
    const fake = makeFakeApi(1);

    // When
    const failure = await applyFailure(plan, fake.api);

    // Then
    expect(failure).toMatchObject({ _tag: "ServiceStartError", service: "web" });
    expect(failure.message).toContain("db:healthy");
    expect(fake.requests).not.toContain("POST /containers/lando-bring-up-order-app-web/start");
    expect(fake.requests.some((request) => request.endsWith("/stop"))).toBe(true);
    expect(fake.requests.some((request) => request.startsWith("DELETE /containers/"))).toBe(true);
  });

  test("succeeds without rolling back when only an optional gate fails", async () => {
    // Given
    const cache = service("cache", {
      dependsOn: [{ service: healthyDb.name, condition: "service_healthy", required: false }],
      healthcheck: undefined,
    });
    const plan = planWith([cache, healthyDb]);
    const fake = makeFakeApi(1);

    // When
    const result = await apply(plan, fake.api);

    // Then
    expect(result.changed).toBe(true);
    expect(fake.requests).toContain("POST /containers/lando-bring-up-order-app-cache/start");
    expect(fake.requests.filter((request) => request.endsWith("/stop"))).toHaveLength(0);
    expect(fake.requests.filter((request) => request.startsWith("DELETE /containers/"))).toHaveLength(0);
  });

  test("does not delete a pre-existing stopped container during rollback", async () => {
    // Given
    const web = service("web", {
      dependsOn: [{ service: healthyDb.name, condition: "service_healthy", required: true }],
      healthcheck: undefined,
    });
    const plan = planWith([web, healthyDb]);
    const db = "lando-bring-up-order-app-db";
    const fake = makeFakeApi(1, [db]);

    // When
    await applyFailure(plan, fake.api);

    // Then
    expect(fake.requests).toContain(`POST /containers/${db}/stop`);
    expect(fake.requests).not.toContain(`DELETE /containers/${db}?force=true`);
  });

  test("cleans only a failed optional dependency and preserves an unrelated started service", async () => {
    // Given
    const api = service("api", { dependsOn: [], healthcheck: undefined });
    const web = service("web", {
      dependsOn: [{ service: healthyDb.name, condition: "service_started", required: false }],
      healthcheck: undefined,
    });
    const plan = planWith([api, healthyDb, web]);
    const apiName = "lando-bring-up-order-app-api";
    const dbName = "lando-bring-up-order-app-db";
    const fake = makeFakeApi(0, [], [dbName]);

    // When
    await apply(plan, fake.api);

    // Then
    expect(fake.requests).toContain(`POST /containers/${apiName}/start`);
    expect(fake.requests).toContain(`POST /containers/${dbName}/stop`);
    expect(fake.requests).toContain(`DELETE /containers/${dbName}?force=true`);
    expect(fake.requests).not.toContain(`POST /containers/${apiName}/stop`);
    expect(fake.requests).not.toContain(`DELETE /containers/${apiName}?force=true`);
    expect(fake.requests).toContain("POST /containers/lando-bring-up-order-app-web/start");
    expect(fake.requests.some((request) => request.startsWith("DELETE /networks/"))).toBe(false);
  });

  test("interrupts an aborted optional dependency instead of starting its dependent", async () => {
    // Given
    const cache = service("cache", {
      dependsOn: [{ service: healthyDb.name, condition: "service_started", required: false }],
      healthcheck: undefined,
    });
    const plan = planWith([cache, healthyDb]);
    const fake = makeFakeApi(0);
    const controller = new AbortController();
    controller.abort();

    // When
    const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: fake.api }));
    const exit = await Effect.runPromiseExit(
      Effect.scoped(provider.apply(plan, { reconcile: false, signal: controller.signal })),
    );

    // Then
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.isInterruptedOnly(exit.cause)).toBe(true);
    else throw new TypeError("aborted Docker apply unexpectedly succeeded");
    expect(fake.requests).not.toContain("POST /containers/lando-bring-up-order-app-cache/start");
  });
});
