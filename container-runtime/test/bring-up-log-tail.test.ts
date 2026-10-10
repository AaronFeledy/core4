import { describe, expect, test } from "bun:test";
import { DateTime, Duration, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import { ServiceStartError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import type { EngineHttpRequest, PodmanApiClient } from "../src/engine-api.ts";
import { serviceContainerName } from "../src/plan.ts";
import { bringUp } from "../src/podman/bring-up.ts";

const providerId = ProviderId.make("lando");
const ctx = { providerId: "podman", remediation: "Run `lando setup` and retry." } as const;
const appId = AppId.make("bring-up-log-tail-app");
const slug = "bring-up-log-tail-app";
const webName = ServiceName.make("web");
const dbName = ServiceName.make("db");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-10-10T00:00:00Z"),
  source: "container-runtime/bring-up-log-tail.test.ts",
  runtime: 4 as const,
};
const textEncoder = new TextEncoder();

const servicePlan = (
  name: ServicePlan["name"],
  primary: boolean,
  overrides: Partial<ServicePlan> = {},
): ServicePlan => ({
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
  ...overrides,
});

const standalonePlan = (): AppPlan => ({
  id: appId,
  name: "Bring Up Log Tail App",
  slug,
  root: AbsolutePath.make("/tmp/bring-up-log-tail-app"),
  provider: providerId,
  services: { [webName]: servicePlan(webName, true) },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

const dependentPlan = (): AppPlan => {
  const db = servicePlan(dbName, false, {
    healthcheck: {
      kind: "command",
      command: ["pg_isready"],
      intervalSeconds: 0,
      timeoutSeconds: 5,
      retries: 1,
    },
  });
  const web = servicePlan(webName, true, {
    dependsOn: [{ service: dbName, condition: "service_healthy", required: true }],
  });
  return {
    id: appId,
    name: "Bring Up Log Tail App",
    slug,
    root: AbsolutePath.make("/tmp/bring-up-log-tail-app"),
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

const rawConsole = (line: string): Uint8Array => textEncoder.encode(`2026-10-10T00:00:00Z ${line}\n`);

const logsQuery = (path: string): URLSearchParams => new URLSearchParams(path.split("?")[1] ?? "");

const makeApi = (options: {
  readonly failedStarts?: ReadonlyArray<string>;
  readonly healthExitCode?: number;
  readonly logsFor?: Readonly<Record<string, ReadonlyArray<Uint8Array>>>;
  readonly hangLogsUnlessFollowFalse?: boolean;
  readonly hangLogs?: boolean;
  readonly failLogs?: boolean;
}) => {
  const requests: string[] = [];
  const containers = new Set<string>();
  const running = new Set<string>();
  const failedStartNames = new Set(options.failedStarts ?? []);
  const record = (request: EngineHttpRequest) => requests.push(`${request.method} ${request.path}`);
  const api: PodmanApiClient = {
    info: Effect.succeed({ host: { arch: "x64" }, version: { Version: "6.0.0" } }),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.sync(() => {
        record(request);
        const containerMatch = request.path.match(/^\/containers\/([^/?]+)(?:\/json|\/start|\/stop)?/u);
        const name = containerMatch?.[1];
        if (request.method === "GET" && request.path.startsWith("/networks/")) {
          return { status: 200, body: "{}" };
        }
        if (request.method === "GET" && request.path.endsWith("/json") && name !== undefined) {
          return containers.has(name)
            ? {
                status: 200,
                body: JSON.stringify({ Id: `id-${name}`, State: { Running: running.has(name) } }),
              }
            : { status: 404, body: "{}" };
        }
        if (request.method === "POST" && request.path.startsWith("/containers/create?name=")) {
          const created = request.path.slice("/containers/create?name=".length);
          containers.add(created);
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
          return { status: 200, body: JSON.stringify({ ExitCode: options.healthExitCode ?? 1 }) };
        }
        if (request.method === "DELETE" && name !== undefined) {
          containers.delete(name);
          running.delete(name);
        }
        return { status: 204, body: "" };
      }),
    stream: (request) => {
      record(request);
      if (options.failLogs === true) {
        return Stream.fail(
          new ServiceStartError({
            providerId: "podman",
            operation: "logs",
            service: "web",
            message: "logs unavailable",
          }),
        );
      }
      const query = logsQuery(request.path);
      if (options.hangLogs === true) return Stream.never;
      if (options.hangLogsUnlessFollowFalse === true && query.get("follow") !== "false") {
        return Stream.never;
      }
      const containerMatch = request.path.match(/^\/containers\/([^/?]+)\/logs/u);
      const name = containerMatch?.[1] ?? "";
      return Stream.fromIterable(options.logsFor?.[name] ?? []);
    },
  };
  return { api, requests };
};

const flipBringUp = (plan: AppPlan, api: PodmanApiClient) =>
  Effect.runPromise(bringUp(plan, { api, ctx }).pipe(Effect.flip));

describe("bringUp start-failure log tail", () => {
  test("attaches a redacted tail and still rolls back when a service dies after start", async () => {
    const plan = standalonePlan();
    const web = serviceContainerName(plan, "web");
    const { api, requests } = makeApi({
      failedStarts: [web],
      logsFor: { [web]: [rawConsole("DATABASE_PASSWORD=hunter2 ready")] },
    });

    const error = await flipBringUp(plan, api);

    expect(error).toMatchObject({ _tag: "ServiceStartError", service: "web" });
    expect(error).toBeInstanceOf(ServiceStartError);
    expect(error.logTail).toEqual({
      service: "web",
      lines: ["DATABASE_PASSWORD=[redacted] ready"],
      truncated: false,
    });
    expect(
      requests.some((request) => request.includes("/logs?") && logsQuery(request).get("follow") === "false"),
    ).toBe(true);
    expect(
      requests.some((request) => request.includes("/logs?") && logsQuery(request).get("tail") === "50"),
    ).toBe(true);
    expect(requests.some((request) => request.endsWith("/stop"))).toBe(true);
    expect(requests.some((request) => request.startsWith("DELETE /containers/"))).toBe(true);
    const logsIndex = requests.findIndex((request) => request.includes("/logs?"));
    const deleteIndex = requests.findIndex((request) => request.startsWith("DELETE /containers/"));
    expect(logsIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(logsIndex);
  });

  test("omits an empty tail from create and start HTTP failures", async () => {
    const plan = standalonePlan();
    const web = serviceContainerName(plan, "web");
    const { api } = makeApi({ failedStarts: [web], logsFor: { [web]: [] } });

    const error = await flipBringUp(plan, api);

    expect(error).toMatchObject({ _tag: "ServiceStartError", service: "web" });
    expect(error.logTail).toBeUndefined();
  });

  test("keeps the original error when log capture fails", async () => {
    const plan = standalonePlan();
    const web = serviceContainerName(plan, "web");
    const { api, requests } = makeApi({ failedStarts: [web], failLogs: true });

    const error = await flipBringUp(plan, api);

    expect(error).toMatchObject({
      _tag: "ServiceStartError",
      service: "web",
      operation: "bringUp.start",
    });
    expect(error.message).toContain("container start failed");
    expect(error.logTail).toBeUndefined();
    expect(requests.some((request) => request.startsWith("DELETE /containers/"))).toBe(true);
  });

  test("keeps the original error when log capture times out", async () => {
    const plan = standalonePlan();
    const web = serviceContainerName(plan, "web");
    const { api, requests } = makeApi({ failedStarts: [web], hangLogs: true });

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(bringUp(plan, { api, ctx }).pipe(Effect.flip));
        yield* TestClock.adjust(Duration.seconds(5));
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(error).toMatchObject({
      _tag: "ServiceStartError",
      service: "web",
      operation: "bringUp.start",
    });
    expect(error.logTail).toBeUndefined();
    expect(requests.some((request) => request.startsWith("DELETE /containers/"))).toBe(true);
  });

  test("does not hang capturing a running but unhealthy dependency", async () => {
    const plan = dependentPlan();
    const db = serviceContainerName(plan, "db");
    const { api, requests } = makeApi({
      healthExitCode: 1,
      hangLogsUnlessFollowFalse: true,
      logsFor: { [db]: [rawConsole("database not accepting connections")] },
    });

    const error = await flipBringUp(plan, api);

    expect(error).toMatchObject({ _tag: "ServiceStartError", service: "web" });
    expect(error.logTail).toEqual({
      service: "db",
      lines: ["database not accepting connections"],
      truncated: false,
      exitCode: 1,
    });
    const logRequest = requests.find((request) => request.includes(`${db}/logs?`));
    expect(logRequest).toBeDefined();
    expect(logsQuery(logRequest ?? "").get("follow")).toBe("false");
    expect(requests.some((request) => request.includes("/web/logs?"))).toBe(false);
    expect(requests.some((request) => request.startsWith("DELETE /containers/"))).toBe(true);
  }, 2000);
});
