import { describe, expect, test } from "bun:test";
import { Cause, DateTime, Deferred, Duration, Effect, Exit, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import { ProviderInternalError, ServiceStartError } from "@lando/sdk/errors";
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
  readonly dieLogs?: boolean;
  readonly onLogs?: () => void;
  readonly abortOnHealthcheck?: AbortController;
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
          options.abortOnHealthcheck?.abort();
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
      const isLogs = /\/logs(?:\?|$)/u.test(request.path);
      if (!isLogs) return Stream.empty;
      options.onLogs?.();
      if (options.dieLogs === true) return Stream.die("boom");
      if (options.failLogs === true) {
        return Stream.fail(
          new ProviderInternalError({
            providerId: "podman",
            operation: "logs",
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

const expectServiceStartError = (error: unknown): ServiceStartError => {
  expect(error).toBeInstanceOf(ServiceStartError);
  if (!(error instanceof ServiceStartError)) {
    throw new Error("expected ServiceStartError");
  }
  return error;
};

describe("bringUp start-failure log tail", () => {
  test("attaches a redacted tail and still rolls back when container start returns HTTP 500", async () => {
    const plan = standalonePlan();
    const web = serviceContainerName(plan, "web");
    const { api, requests } = makeApi({
      failedStarts: [web],
      logsFor: { [web]: [rawConsole("DATABASE_PASSWORD=hunter2 ready")] },
    });

    const error = await flipBringUp(plan, api);

    expect(error).toMatchObject({ _tag: "ServiceStartError", service: "web" });
    expect(expectServiceStartError(error).logTail).toEqual({
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
    expect(expectServiceStartError(error).logTail).toBeUndefined();
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
    expect(expectServiceStartError(error).logTail).toBeUndefined();
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
    expect(expectServiceStartError(error).logTail).toBeUndefined();
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
    expect(expectServiceStartError(error).logTail).toEqual({
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

  test("keeps the end of a capped tail, including a huge last line", async () => {
    const plan = standalonePlan();
    const web = serviceContainerName(plan, "web");
    const bodies = Array.from({ length: 50 }, (_, index) => `line-${String(index).padStart(2, "0")} ${"x".repeat(152)}`);
    const { api } = makeApi({
      failedStarts: [web],
      logsFor: { [web]: bodies.map((body) => rawConsole(body)) },
    });

    const many = expectServiceStartError(await flipBringUp(plan, api)).logTail;
    const manyJoined = many?.lines.join("\n") ?? "";
    expect(many?.truncated).toBe(true);
    expect(manyJoined.endsWith(bodies[49] ?? "")).toBe(true);
    expect(manyJoined.includes(bodies[0] ?? "")).toBe(false);
    expect(bodies.join("\n").endsWith(manyJoined)).toBe(true);
    expect(manyJoined.length).toBeLessThanOrEqual(4000);

    const fatal = `FATAL ${"y".repeat(5000)}`;
    const { api: fatalApi } = makeApi({
      failedStarts: [web],
      logsFor: { [web]: [rawConsole("line-00 ready"), rawConsole(fatal)] },
    });
    const hugeLast = expectServiceStartError(await flipBringUp(plan, fatalApi)).logTail;
    expect(hugeLast?.truncated).toBe(true);
    expect(hugeLast?.lines).toHaveLength(1);
    expect(fatal.endsWith(hugeLast?.lines[0] ?? "")).toBe(true);
    expect(hugeLast?.lines[0]?.startsWith("FATAL")).toBe(false);
    expect(hugeLast?.lines[0]?.length).toBe(4000);
  });

  test("keeps the end of a single line over the cap", async () => {
    const plan = standalonePlan();
    const web = serviceContainerName(plan, "web");
    const line = `z`.repeat(5000);
    const { api } = makeApi({
      failedStarts: [web],
      logsFor: { [web]: [rawConsole(line)] },
    });

    const tail = expectServiceStartError(await flipBringUp(plan, api)).logTail;
    expect(tail?.truncated).toBe(true);
    expect(tail?.lines).toHaveLength(1);
    expect(tail?.lines[0]?.length).toBe(4000);
    expect(line.endsWith(tail?.lines[0] ?? "")).toBe(true);
  });

  test("keeps the original error and rolls back when log capture defects", async () => {
    const plan = standalonePlan();
    const web = serviceContainerName(plan, "web");
    const { api, requests } = makeApi({ failedStarts: [web], dieLogs: true });

    const error = await flipBringUp(plan, api);

    expect(error).toBeInstanceOf(ServiceStartError);
    expect(error).toMatchObject({
      _tag: "ServiceStartError",
      service: "web",
      operation: "bringUp.start",
    });
    expect(error.message).toContain("container start failed");
    expect(expectServiceStartError(error).logTail).toBeUndefined();
    expect(requests.some((request) => request.startsWith("DELETE /containers/"))).toBe(true);
  });

  test("skips capture when start is aborted before the blocked-gate tail", async () => {
    const plan = dependentPlan();
    const controller = new AbortController();
    const { api, requests } = makeApi({
      healthExitCode: 1,
      abortOnHealthcheck: controller,
      logsFor: { [serviceContainerName(plan, "db")]: [rawConsole("should not capture")] },
    });

    const exit = await Effect.runPromise(
      bringUp(plan, { api, ctx, signal: controller.signal }).pipe(Effect.exit),
    );

    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(requests.some((request) => request.includes("/logs?"))).toBe(false);
    expect(requests.some((request) => request.startsWith("DELETE /containers/"))).toBe(true);
  });

  test("rolls back when interrupted during a blocked-gate log capture", async () => {
    const plan = dependentPlan();
    const started = await Effect.runPromise(Deferred.make<void>());
    const { api, requests } = makeApi({
      healthExitCode: 1,
      hangLogs: true,
      onLogs: () => {
        Effect.runSync(Deferred.succeed(started, undefined));
      },
    });

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(bringUp(plan, { api, ctx }));
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }),
    );

    expect(Exit.match(exit, { onFailure: Cause.hasInterruptsOnly, onSuccess: () => false })).toBe(true);
    expect(requests.some((request) => request.includes("/logs?"))).toBe(true);
    expect(requests.some((request) => request.startsWith("DELETE /containers/"))).toBe(true);
  });
});
