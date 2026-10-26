import { describe, expect, test } from "bun:test";
import { Cause, DateTime, Effect, Exit, Schema, Stream } from "effect";

import { commonContainerLabels } from "@lando/container-runtime/plan";
import type { DockerApiClient, DockerHttpResponse } from "@lando/provider-docker";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServicePlan } from "@lando/sdk/schema";
import { makeRuntimeProvider } from "./provider-fixture.ts";

const providerId = ProviderId.make("docker");
const appId = AppId.make("bring-up-order-app");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-07-26T00:00:00Z"),
  source: "provider-docker/bring-up-order.test.ts",
  runtime: 4 as const,
};

const service = (
  name: string,
  options: {
    readonly dependsOn: ServicePlan["dependsOn"];
    readonly healthcheck?: ServicePlan["healthcheck"];
  },
): ServicePlan => ({
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
  valueModel: 1,
  id: appId,
  name: "Bring Up Order App",
  slug: "bring-up-order-app",
  root: AbsolutePath.make("/tmp/bring-up-order-app"),
  provider: providerId,
  services: Object.fromEntries(services.map((entry) => [entry.name, entry])),
  routes: [],
  networking: { perAppBridge: { name: "lando-bring-up-order-app", driver: "bridge" } },
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

const CreateBodyLabels = Schema.Struct({
  Labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const makeFakeApi = (
  healthExitCode: number,
  existing: ReadonlyArray<string> = [],
  failedStarts: ReadonlyArray<string> = [],
) => {
  const requests: string[] = [];
  const labels = new Map<string, Readonly<Record<string, string>>>();
  const existingNames = new Set(existing);
  const runningNames = new Set<string>();
  const failedStartNames = new Set(failedStarts);
  const ids = new Map<string, string>(existing.map((name) => [name, `id-${name}-original`]));
  const images = new Set<string>();
  let createdSeq = 0;
  const resolveContainer = (ref: string) => {
    if (existingNames.has(ref) || ids.has(ref)) return ref;
    for (const [name, id] of ids) {
      if (id === ref) return name;
    }
    return ref;
  };
  const responseFor = (method: string, path: string): DockerHttpResponse => {
    if (method === "GET" && path.startsWith("/networks/")) return { status: 404, body: "" };
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
      const name = resolveContainer(path.slice("/containers/".length, -"/json".length));
      return existingNames.has(name)
        ? {
            status: 200,
            body: JSON.stringify({
              Id: ids.get(name),
              Config: { Labels: labels.get(name) },
              State: { Running: runningNames.has(name) },
            }),
          }
        : { status: 404, body: "" };
    }
    if (path.startsWith("/containers/create?")) {
      const name = new URL(`http://localhost${path}`).searchParams.get("name");
      if (name !== null) {
        existingNames.add(name);
        createdSeq += 1;
        ids.set(name, `id-${name}-created-${createdSeq}`);
      }
      return { status: 201, body: "" };
    }
    if (path.endsWith("/start")) {
      const name = resolveContainer(path.slice("/containers/".length, -"/start".length));
      if (failedStartNames.has(name)) return { status: 500, body: '{"message":"synthetic start failure"}' };
      runningNames.add(name);
      return { status: 204, body: "" };
    }
    if (method === "POST" && path.endsWith("/exec")) return { status: 201, body: '{"Id":"health"}' };
    if (path === "/exec/health/json") {
      return { status: 200, body: JSON.stringify({ ExitCode: healthExitCode }) };
    }
    if (path.endsWith("/stop")) {
      const name = resolveContainer(path.slice("/containers/".length, -"/stop".length));
      if (!existingNames.has(name)) return { status: 404, body: "" };
      runningNames.delete(name);
      return { status: 204, body: "" };
    }
    if (method === "DELETE") {
      if (path.startsWith("/containers/")) {
        const name = resolveContainer(path.slice("/containers/".length).split("?")[0] ?? "");
        const removed = existingNames.delete(name);
        runningNames.delete(name);
        labels.delete(name);
        ids.delete(name);
        return { status: removed ? 204 : 404, body: "" };
      }
      return { status: 204, body: "" };
    }
    return { status: 500, body: '{"message":"unexpected request"}' };
  };
  const api: DockerApiClient = {
    info: Effect.succeed({}),
    request: ({ method, path, body }) => {
      requests.push(`${method} ${path}`);
      if (method === "POST" && path.startsWith("/containers/create?")) {
        const name = new URL(`http://localhost${path}`).searchParams.get("name") ?? "";
        const decoded = Schema.decodeUnknownSync(CreateBodyLabels)(body);
        labels.set(name, decoded.Labels ?? {});
      }
      return Effect.succeed(responseFor(method, path));
    },
    stream: ({ method, path }) => {
      requests.push(`${method} ${path}`);
      if (method === "POST" && path.startsWith("/images/create?")) {
        responseFor(method, path);
      }
      return Stream.empty;
    },
  };
  return { api, requests, labels, existingNames, runningNames, failedStartNames, ids };
};

const apply = async (plan: AppPlan, api: DockerApiClient, signal?: AbortSignal, reconcile = false) => {
  const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: api }));
  return Effect.runPromise(
    Effect.scoped(provider.apply(plan, { reconcile, ...(signal === undefined ? {} : { signal }) })),
  );
};

const applyFailure = async (plan: AppPlan, api: DockerApiClient) => {
  const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: api }));
  return Effect.runPromise(Effect.flip(Effect.scoped(provider.apply(plan, { reconcile: false }))));
};

describe("provider-docker bringUp dependency order", () => {
  test("deletes then creates a pre-existing stopped container when reconcile is true", async () => {
    // Given
    const name = "lando-bring-up-order-app-web";
    const fake = makeFakeApi(0, [name]);
    const plan = planWith([service("web", { dependsOn: [] })]);
    fake.labels.set(name, commonContainerLabels(plan, service("web", { dependsOn: [] })));
    const originalId = fake.ids.get(name);
    if (originalId === undefined) throw new TypeError("expected seeded generation id");

    // When
    await apply(plan, fake.api, undefined, true);

    // Then
    const removed = fake.requests.indexOf(`DELETE /containers/${originalId}?force=true&v=true`);
    const created = fake.requests.indexOf(`POST /containers/create?name=${name}`);
    expect(removed).toBeGreaterThan(-1);
    expect(created).toBeGreaterThan(removed);
    expect(fake.requests.indexOf(`POST /containers/${name}/start`)).toBeGreaterThan(created);
    expect(fake.ids.get(name)).not.toBe(originalId);
  });

  test("starts a pre-existing stopped container without deleting it when reconcile is false", async () => {
    // Given
    const name = "lando-bring-up-order-app-web";
    const fake = makeFakeApi(0, [name]);
    const plan = planWith([service("web", { dependsOn: [] })]);
    fake.labels.set(name, commonContainerLabels(plan, service("web", { dependsOn: [] })));

    // When
    await apply(plan, fake.api, undefined, false);

    // Then
    expect(fake.requests).toContain(`POST /containers/${name}/start`);
    expect(fake.requests.filter((request) => request.startsWith("DELETE /containers/"))).toEqual([]);
    expect(fake.requests.filter((request) => request.startsWith("POST /containers/create?"))).toEqual([]);
  });

  test("starts a service_healthy dependency and probes it before starting the dependent", async () => {
    // Given
    const web = service("web", {
      dependsOn: [{ service: healthyDb.name, condition: "service_healthy", required: true }],
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

  test("fails naming the unmet gate and retains started containers", async () => {
    // Given
    const web = service("web", {
      dependsOn: [{ service: healthyDb.name, condition: "service_healthy", required: true }],
    });
    const plan = planWith([web, healthyDb]);
    const fake = makeFakeApi(1);

    // When
    const failure = await applyFailure(plan, fake.api);

    // Then
    expect(failure).toMatchObject({ _tag: "ServiceStartError", service: "web" });
    expect(failure.message).toContain("db:healthy");
    expect(fake.requests).not.toContain("POST /containers/lando-bring-up-order-app-web/start");
    expect(fake.requests).toContain("POST /containers/lando-bring-up-order-app-db/start");
    expect(fake.requests.filter((request) => request.endsWith("/stop"))).toEqual([]);
    expect(fake.requests.filter((request) => request.startsWith("DELETE /containers/"))).toEqual([]);
  });

  test("succeeds without rolling back when only an optional gate fails", async () => {
    // Given
    const cache = service("cache", {
      dependsOn: [{ service: healthyDb.name, condition: "service_healthy", required: false }],
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

  test("retains a pre-existing stopped container when a required gate fails", async () => {
    // Given
    const web = service("web", {
      dependsOn: [{ service: healthyDb.name, condition: "service_healthy", required: true }],
    });
    const plan = planWith([web, healthyDb]);
    const db = "lando-bring-up-order-app-db";
    const fake = makeFakeApi(1, [db]);
    fake.labels.set(db, commonContainerLabels(plan, healthyDb));

    // When
    await applyFailure(plan, fake.api);

    // Then
    expect(fake.requests.filter((request) => request.endsWith("/stop"))).toEqual([]);
    expect(fake.requests.filter((request) => request.startsWith("DELETE /containers/"))).toEqual([]);
    expect(fake.requests).toContain(`POST /containers/${db}/start`);
  });

  test("optional start failure retains the failed dependency and preserves unrelated started services", async () => {
    // Given
    const api = service("api", { dependsOn: [] });
    const web = service("web", {
      dependsOn: [{ service: healthyDb.name, condition: "service_started", required: false }],
    });
    const plan = planWith([api, healthyDb, web]);
    const apiName = "lando-bring-up-order-app-api";
    const dbName = "lando-bring-up-order-app-db";
    const fake = makeFakeApi(0, [], [dbName]);

    // When
    await apply(plan, fake.api);

    // Then
    expect(fake.requests).toContain(`POST /containers/${apiName}/start`);
    expect(fake.requests).toContain(`POST /containers/${dbName}/start`);
    expect(fake.requests.filter((request) => request.endsWith("/stop"))).toEqual([]);
    expect(fake.requests.filter((request) => request.startsWith("DELETE /containers/"))).toEqual([]);
    expect(fake.requests).toContain("POST /containers/lando-bring-up-order-app-web/start");
    expect(fake.requests.some((request) => request.startsWith("DELETE /networks/"))).toBe(false);
  });

  test("unchanged container ID across failed B then retry", async () => {
    // Given two independent services; B fails on the first attempt on the same fake daemon.
    const apiSvc = service("api", { dependsOn: [] });
    const webSvc = service("web", { dependsOn: [] });
    const plan = planWith([apiSvc, webSvc]);
    const apiName = "lando-bring-up-order-app-api";
    const webName = "lando-bring-up-order-app-web";
    const fake = makeFakeApi(0, [], [webName]);
    await applyFailure(plan, fake.api);
    const apiIdAfterFail = fake.ids.get(apiName);
    const webIdAfterFail = fake.ids.get(webName);
    if (apiIdAfterFail === undefined || webIdAfterFail === undefined) {
      throw new TypeError("expected generation-unique A/B ids after failed attempt");
    }
    expect(apiIdAfterFail).not.toBe(webIdAfterFail);
    expect(fake.requests.filter((request) => request.startsWith("DELETE /containers/"))).toEqual([]);

    // When: clear the injected start fault and retry on the same daemon state.
    fake.failedStartNames.delete(webName);
    const requestsBeforeRetry = fake.requests.length;
    await apply(plan, fake.api);
    const retryRequests = fake.requests.slice(requestsBeforeRetry);

    // Then: A and B keep their generation-unique identities; neither is recreated.
    expect(fake.ids.get(apiName)).toBe(apiIdAfterFail);
    expect(fake.ids.get(webName)).toBe(webIdAfterFail);
    expect(retryRequests.some((request) => request.includes("/containers/create"))).toBe(false);
    expect(retryRequests.filter((request) => request.startsWith("DELETE /containers/"))).toEqual([]);
    expect(retryRequests).toContain(`POST /containers/${webName}/start`);
  });

  test("corrected config recreates ONLY B", async () => {
    // Given A starts and B fails start under the original create-config on one fake daemon.
    const apiSvc = service("api", { dependsOn: [] });
    const webSvc = service("web", { dependsOn: [] });
    const plan = planWith([apiSvc, webSvc]);
    const apiName = "lando-bring-up-order-app-api";
    const webName = "lando-bring-up-order-app-web";
    const fake = makeFakeApi(0, [], [webName]);
    await applyFailure(plan, fake.api);
    const apiId = fake.ids.get(apiName);
    const webId = fake.ids.get(webName);
    if (apiId === undefined || webId === undefined) {
      throw new TypeError("expected generation-unique A/B ids after failed B start");
    }

    // When: correct B environment/command, clear the injected start fault, retry same fake.
    const correctedWeb = { ...webSvc, environment: { FIXED: "yes" }, command: ["sleep", "infinity"] };
    const corrected = planWith([apiSvc, correctedWeb]);
    fake.failedStartNames.delete(webName);
    const requestsBeforeRetry = fake.requests.length;
    await apply(corrected, fake.api);
    const retryRequests = fake.requests.slice(requestsBeforeRetry);

    // Then: only B is recreated; A identity is unchanged.
    const webIdAfter = fake.ids.get(webName);
    if (webIdAfter === undefined) throw new TypeError("expected recreated B id");
    expect(fake.ids.get(apiName)).toBe(apiId);
    expect(webIdAfter).not.toBe(webId);
    expect(retryRequests.some((request) => request === `DELETE /containers/${webId}?force=true&v=true`)).toBe(
      true,
    );
    expect(
      retryRequests.some((request) => request.startsWith("DELETE /containers/") && request.includes(apiId)),
    ).toBe(false);
    expect(
      retryRequests.filter((request) => request === `POST /containers/create?name=${webName}`).length,
    ).toBeGreaterThan(0);
    expect(retryRequests.filter((request) => request === `POST /containers/create?name=${apiName}`)).toEqual(
      [],
    );
  });

  test("interrupts an aborted optional dependency instead of starting its dependent", async () => {
    // Given
    const cache = service("cache", {
      dependsOn: [{ service: healthyDb.name, condition: "service_started", required: false }],
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
    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    else throw new TypeError("aborted Docker apply unexpectedly succeeded");
    expect(fake.requests).not.toContain("POST /containers/lando-bring-up-order-app-cache/start");
  });
});
