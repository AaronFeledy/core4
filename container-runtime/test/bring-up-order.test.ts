import { expect, test } from "bun:test";
import { Cause, DateTime, Effect, Exit, Option, Schema, Stream } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { EngineHttpRequest, PodmanApiClient } from "../src/engine-api.ts";
import { commonContainerLabels } from "../src/plan.ts";
import { bringUp } from "../src/podman/bring-up.ts";

const providerId = ProviderId.make("lando");
const ctx = { providerId: "podman", remediation: "Run `lando setup` and retry.", env: {} } as const;
const appId = AppId.make("bring-up-order-app");
const dbName = ServiceName.make("db");
const dependentNames = {
  web: ServiceName.make("web"),
  cache: ServiceName.make("cache"),
};
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-07-26T00:00:00Z"),
  source: "container-runtime/bring-up-order.test.ts",
  runtime: 4 as const,
};

const servicePlan = (name: ServicePlan["name"], primary: boolean): ServicePlan => ({
  name,
  type: "generic",
  provider: providerId,
  primary,
  artifact: { kind: "ref", ref: "debian:12.11-slim" },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const planWithDependency = (dependentName: ServicePlan["name"], required: boolean): AppPlan => {
  const db: ServicePlan = {
    ...servicePlan(dbName, false),
    healthcheck: {
      kind: "command",
      command: ["pg_isready"],
      intervalSeconds: 0,
      timeoutSeconds: 5,
      retries: 1,
    },
  };
  const dependent: ServicePlan = {
    ...servicePlan(dependentName, true),
    dependsOn: [{ service: dbName, condition: "service_healthy", required }],
  };

  return {
    id: appId,
    valueModel: 1,
    name: "Bring Up Order App",
    slug: "bring-up-order-app",
    root: AbsolutePath.make("/tmp/bring-up-order-app"),
    provider: providerId,
    services: { [dependentName]: dependent, [dbName]: db },
    routes: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const makePodmanApi = (
  healthExitCode: number,
  existing: ReadonlyArray<string> = [],
  failedStarts: ReadonlyArray<string> = [],
  alreadyRunning: ReadonlyArray<string> = [],
) => {
  const labelFor = (name: string): Readonly<Record<string, string>> =>
    commonContainerLabels(
      planWithDependency(dependentNames.web, true),
      name.endsWith("-db")
        ? (planWithDependency(dependentNames.web, true).services[dbName] ?? servicePlan(dbName, false))
        : name.endsWith("-api")
          ? servicePlan(ServiceName.make("api"), false)
          : name.endsWith("-cache")
            ? servicePlan(dependentNames.cache, true)
            : servicePlan(dependentNames.web, true),
    );
  const requests: string[] = [];
  const containers = new Set(existing);
  const running = new Set(alreadyRunning);
  const failedStartNames = new Set(failedStarts);
  const ids = new Map<string, string>(existing.map((name) => [name, `id-${name}-original`]));
  const inspectLabels = new Map<string, Readonly<Record<string, string>>>(
    existing.map((name) => [name, labelFor(name)]),
  );
  let createdSeq = 0;
  const record = (request: EngineHttpRequest) => requests.push(`${request.method} ${request.path}`);
  const resolveName = (ref: string | undefined): string | undefined => {
    if (ref === undefined) return undefined;
    if (containers.has(ref) || ids.has(ref)) return ref;
    for (const [name, id] of ids) {
      if (id === ref) return name;
    }
    return ref;
  };
  const api: PodmanApiClient = {
    info: Effect.succeed({ host: { arch: "x64" }, version: { Version: "6.0.0" } }),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.sync(() => {
        record(request);
        const containerMatch = request.path.match(/^\/containers\/([^/?]+)/u);
        const name = resolveName(containerMatch?.[1]);
        if (request.method === "GET" && request.path.startsWith("/networks/")) {
          return { status: 200, body: "{}" };
        }
        if (request.method === "GET" && request.path.endsWith("/json") && name !== undefined) {
          return containers.has(name)
            ? {
                status: 200,
                body: JSON.stringify({
                  Id: ids.get(name),
                  Config: {
                    Labels: inspectLabels.get(name) ?? labelFor(name),
                  },
                  State: { Running: running.has(name) },
                }),
              }
            : { status: 404, body: "{}" };
        }
        if (request.method === "POST" && request.path.startsWith("/containers/create?name=")) {
          const created = request.path.slice("/containers/create?name=".length);
          containers.add(created);
          createdSeq += 1;
          ids.set(created, `id-${created}-created-${createdSeq}`);
          // New creates carry the live planned labels from the create body when present.
          const decodedBody = Schema.decodeUnknownOption(
            Schema.Struct({ Labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) }),
          )(request.body);
          const bodyLabels =
            Option.isSome(decodedBody) && decodedBody.value.Labels !== undefined
              ? decodedBody.value.Labels
              : labelFor(created);
          inspectLabels.set(created, bodyLabels);
          return { status: 201, body: "{}" };
        }
        if (request.method === "POST" && request.path.endsWith("/start") && name !== undefined) {
          if (failedStartNames.has(name)) {
            return { status: 500, body: '{"message":"synthetic start failure"}' };
          }
          running.add(name);
          return { status: 204, body: "" };
        }
        if (request.method === "POST" && request.path.endsWith("/exec")) {
          return { status: 201, body: '{"Id":"health-exec"}' };
        }
        if (request.method === "GET" && request.path === "/exec/health-exec/json") {
          return { status: 200, body: JSON.stringify({ ExitCode: healthExitCode }) };
        }
        if (request.method === "POST" && request.path.endsWith("/stop") && name !== undefined) {
          running.delete(name);
          return { status: 204, body: "" };
        }
        if (request.method === "DELETE" && name !== undefined) {
          containers.delete(name);
          running.delete(name);
          ids.delete(name);
          inspectLabels.delete(name);
          return { status: 204, body: "" };
        }
        return { status: 204, body: "" };
      }),
    stream: (request) => {
      record(request);
      return Stream.empty;
    },
  };
  return { api, requests, ids, failedStartNames };
};

test("starts a service_healthy dependency and probes it before starting the dependent", async () => {
  // Given
  const plan = planWithDependency(dependentNames.web, true);
  const { api, requests } = makePodmanApi(0);

  // When
  await Effect.runPromise(bringUp(plan, { api, ctx }));

  // Then
  const dbStart = requests.indexOf("POST /containers/lando-bring-up-order-app-db/start");
  const dbExec = requests.indexOf("POST /containers/lando-bring-up-order-app-db/exec");
  const webStart = requests.indexOf("POST /containers/lando-bring-up-order-app-web/start");
  expect(dbStart).toBeGreaterThanOrEqual(0);
  expect(dbExec).toBeGreaterThan(dbStart);
  expect(webStart).toBeGreaterThan(dbExec);
});

test("selected apply accepts a fast exit-0 job identified by the full completion plan", async () => {
  const original = planWithDependency(dependentNames.web, true);
  const dependent = original.services[dependentNames.web];
  const db = original.services[dbName];
  if (dependent === undefined || db === undefined) throw new TypeError("Expected services");
  const full = {
    ...original,
    services: {
      [dbName]: db,
      [dependentNames.web]: {
        ...dependent,
        dependsOn: [
          { service: dbName, condition: "service_completed_successfully" as const, required: true },
        ],
      },
    },
  };
  const selected = { ...full, services: { [dbName]: db } };
  const fake = makePodmanApi(0);
  const request = fake.api.request;
  if (request === undefined) throw new TypeError("Expected request transport");
  let started = false;
  const api: PodmanApiClient = {
    ...fake.api,
    request: (input) =>
      request(input).pipe(
        Effect.map((response) => {
          if (input.path.endsWith("/start")) started = true;
          return started && input.path.endsWith("/json")
            ? {
                status: 200,
                body: JSON.stringify({
                  Id: "job-container",
                  State: { Running: false, Status: "exited", ExitCode: 0 },
                }),
              }
            : response;
        }),
      ),
  };
  const result = await Effect.runPromise(bringUp(selected, { api, ctx, completionPlan: full }));
  expect(result.changed).toBe(true);
  expect(fake.requests.some((path) => path.endsWith("/stop"))).toBe(false);
});

test("apply retains a supervised worker that exits before the immediate running check", async () => {
  const worker = { ...servicePlan(dbName, false), extensions: { compose: { restart: "unless-stopped" } } };
  const plan = { ...planWithDependency(dependentNames.web, true), services: { [dbName]: worker } };
  const fake = makePodmanApi(0);
  const request = fake.api.request;
  if (request === undefined) throw new TypeError("Expected request transport");
  let started = false;
  const api: PodmanApiClient = {
    ...fake.api,
    request: (input) =>
      request(input).pipe(
        Effect.map((response) => {
          if (input.path.endsWith("/start")) started = true;
          return started && input.path.endsWith("/json")
            ? {
                status: 200,
                body: JSON.stringify({
                  Id: "supervised-worker",
                  State: { Running: false, Status: "exited", ExitCode: 7 },
                }),
              }
            : response;
        }),
      ),
  };
  const result = await Effect.runPromise(bringUp(plan, { api, ctx }));
  expect(result.changed).toBe(true);
  expect(fake.requests.some((path) => path.endsWith("/stop"))).toBe(false);
});

test("retains a pre-existing stopped container when a required gate fails", async () => {
  // Given
  const plan = planWithDependency(dependentNames.web, true);
  const db = "lando-bring-up-order-app-db";
  const { api, requests, ids } = makePodmanApi(1, [db]);
  const dbId = ids.get(db);

  // When
  await Effect.runPromise(bringUp(plan, { api, ctx }).pipe(Effect.flip));

  // Then: no compensation stop/delete; native identity stays put for retry.
  expect(ids.get(db)).toBe(dbId);
  expect(requests.filter((request) => request.endsWith("/stop"))).toEqual([]);
  expect(requests.filter((request) => request.startsWith("DELETE /containers/"))).toEqual([]);
});

test("fails with ServiceStartError naming the unmet gate and retains started containers", async () => {
  // Given
  const plan = planWithDependency(dependentNames.web, true);
  const { api, requests } = makePodmanApi(1);

  // When
  const error = await Effect.runPromise(bringUp(plan, { api, ctx }).pipe(Effect.flip));

  // Then
  expect(error).toMatchObject({ _tag: "ServiceStartError", service: "web" });
  expect(error.message).toContain("db:healthy");
  expect(requests).not.toContain("POST /containers/lando-bring-up-order-app-web/start");
  expect(requests).toContain("POST /containers/lando-bring-up-order-app-db/start");
  expect(requests.filter((request) => request.endsWith("/stop"))).toEqual([]);
  expect(requests.filter((request) => request.startsWith("DELETE /containers/"))).toEqual([]);
});

test("succeeds without rolling back when only an optional gate fails", async () => {
  // Given
  const plan = planWithDependency(dependentNames.cache, false);
  const { api, requests } = makePodmanApi(1);

  // When
  const result = await Effect.runPromise(bringUp(plan, { api, ctx }));

  // Then
  expect(result.changed).toBe(true);
  expect(requests).toContain("POST /containers/lando-bring-up-order-app-cache/start");
  expect(requests.filter((request) => request.endsWith("/stop"))).toHaveLength(0);
  expect(requests.filter((request) => request.startsWith("DELETE /containers/"))).toHaveLength(0);
});

test("optional start failure retains the failed dependency and preserves unrelated started services", async () => {
  // Given
  const base = planWithDependency(dependentNames.cache, false);
  const apiService = servicePlan(ServiceName.make("api"), false);
  const plan = { ...base, services: { api: apiService, ...base.services } };
  const apiName = "lando-bring-up-order-app-api";
  const db = "lando-bring-up-order-app-db";
  const { api, requests, ids } = makePodmanApi(0, [], [db]);

  // When
  await Effect.runPromise(bringUp(plan, { api, ctx }));

  // Then: optional failure is tolerated; nothing is compensated away.
  expect(requests).toContain(`POST /containers/${apiName}/start`);
  expect(requests).toContain(`POST /containers/${db}/start`);
  expect(ids.has(db)).toBe(true);
  expect(requests.filter((request) => request.endsWith("/stop"))).toEqual([]);
  expect(requests.filter((request) => request.startsWith("DELETE /containers/"))).toEqual([]);
  expect(requests).toContain("POST /containers/lando-bring-up-order-app-cache/start");
  expect(requests.some((request) => request.startsWith("DELETE /networks/"))).toBe(false);
});

test("interrupts an aborted optional dependency instead of starting its dependent", async () => {
  // Given
  const plan = planWithDependency(dependentNames.cache, false);
  const { api, requests } = makePodmanApi(0);
  const controller = new AbortController();
  controller.abort();

  // When
  const exit = await Effect.runPromiseExit(bringUp(plan, { api, ctx, signal: controller.signal }));

  // Then
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  else throw new TypeError("aborted Podman bringUp unexpectedly succeeded");
  expect(requests).not.toContain("POST /containers/lando-bring-up-order-app-cache/start");
});

test("unchanged container ID across failed B then retry", async () => {
  // Given two independent services; B fails on the first attempt on the same fake daemon.
  const apiSvc = servicePlan(ServiceName.make("api"), false);
  const webSvc = servicePlan(dependentNames.web, true);
  const plan: AppPlan = {
    id: appId,
    valueModel: 1,
    name: "Bring Up Order App",
    slug: "bring-up-order-app",
    root: AbsolutePath.make("/tmp/bring-up-order-app"),
    provider: providerId,
    services: { [apiSvc.name]: apiSvc, [webSvc.name]: webSvc },
    routes: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
  const apiName = "lando-bring-up-order-app-api";
  const webName = "lando-bring-up-order-app-web";
  const fake = makePodmanApi(0, [], [webName]);
  await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }).pipe(Effect.flip));
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
  await Effect.runPromise(bringUp(plan, { api: fake.api, ctx, reconcile: false }));
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
  const apiSvc = servicePlan(ServiceName.make("api"), false);
  const webSvc = servicePlan(dependentNames.web, true);
  const plan: AppPlan = {
    id: appId,
    valueModel: 1,
    name: "Bring Up Order App",
    slug: "bring-up-order-app",
    root: AbsolutePath.make("/tmp/bring-up-order-app"),
    provider: providerId,
    services: { [apiSvc.name]: apiSvc, [webSvc.name]: webSvc },
    routes: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
  const apiName = "lando-bring-up-order-app-api";
  const webName = "lando-bring-up-order-app-web";
  const fake = makePodmanApi(0, [], [webName]);
  await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }).pipe(Effect.flip));
  const apiId = fake.ids.get(apiName);
  const webId = fake.ids.get(webName);
  if (apiId === undefined || webId === undefined) {
    throw new TypeError("expected generation-unique A/B ids after failed B start");
  }

  // When: correct B environment/command, clear the injected start fault, retry same fake.
  const correctedWeb = { ...webSvc, environment: { FIXED: "yes" }, command: ["sleep", "infinity"] };
  const corrected: AppPlan = {
    ...plan,
    services: { [apiSvc.name]: apiSvc, [correctedWeb.name]: correctedWeb },
  };
  fake.failedStartNames.delete(webName);
  const requestsBeforeRetry = fake.requests.length;
  await Effect.runPromise(bringUp(corrected, { api: fake.api, ctx, reconcile: false }));
  const retryRequests = fake.requests.slice(requestsBeforeRetry);

  // Then: only B is stopped/removed/recreated; A identity is unchanged.
  const webIdAfter = fake.ids.get(webName);
  if (webIdAfter === undefined) throw new TypeError("expected recreated B id");
  expect(fake.ids.get(apiName)).toBe(apiId);
  expect(webIdAfter).not.toBe(webId);
  expect(
    retryRequests.some((request) => request.startsWith("DELETE /containers/") && request.includes(webId)),
  ).toBe(true);
  expect(
    retryRequests.some((request) => request.includes("/containers/create") && request.includes(webName)),
  ).toBe(true);
  expect(
    retryRequests.some((request) => request.includes("/containers/create") && request.includes(apiName)),
  ).toBe(false);
  expect(
    retryRequests.filter((request) => request.startsWith("DELETE /containers/") && request.includes(apiId)),
  ).toEqual([]);
});

test("a filtered apply leaves an unselected container's real ID untouched", async () => {
  const web = servicePlan(dependentNames.web, true);
  const db = servicePlan(dbName, false);
  const fullPlan: AppPlan = {
    valueModel: 1,
    id: appId,
    name: "Bring Up Order App",
    slug: "bring-up-order-app",
    root: AbsolutePath.make("/tmp/bring-up-order-app"),
    provider: providerId,
    services: { [web.name]: web, [db.name]: db },
    routes: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
  const dbContainer = "lando-bring-up-order-app-db";
  const webContainer = "lando-bring-up-order-app-web";
  const { api, requests, ids } = makePodmanApi(
    0,
    [dbContainer, webContainer],
    [],
    [dbContainer, webContainer],
  );
  const dbId = ids.get(dbContainer);

  await Effect.runPromise(
    bringUp({ ...fullPlan, services: { [web.name]: web } }, { api, ctx, reconcile: false }),
  );

  expect(dbId).toBe(`id-${dbContainer}-original`);
  expect(ids.get(dbContainer)).toBe(dbId);
  expect(ids.get(webContainer)).toBe(`id-${webContainer}-original`);
  expect(requests.filter((request) => request.includes(dbContainer))).toEqual([]);
  expect(requests.some((request) => request.startsWith(`DELETE /containers/${dbContainer}`))).toBe(false);
  expect(
    requests.some((request) => request.includes("/containers/create") && request.includes(dbContainer)),
  ).toBe(false);
});
