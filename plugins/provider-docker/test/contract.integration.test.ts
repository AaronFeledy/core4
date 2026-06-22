import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProviderUnavailableError, type ServiceStartError } from "@lando/sdk/errors";
import { Cause, DateTime, Effect, Exit, Fiber, Stream } from "effect";

import {
  type DockerApiClient,
  type DockerHttpRequest,
  type DockerHttpResponse,
  linuxDockerCapabilities,
  makeDockerApiClient,
  makeProviderLayer,
  renderCompose,
} from "@lando/provider-docker";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";
import { runProviderContract, runProviderContractMatrix } from "@lando/sdk/test";

const appId = AppId.make("myapp");
const serviceName = ServiceName.make("web");
const providerId = ProviderId.make("docker");
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-10T18:51:00Z"),
  source: "provider-docker.test",
  runtime: 4 as const,
};

const attachFrame = (stream: 1 | 2, text: string) => {
  const payload = textEncoder.encode(text);
  const frame = new Uint8Array(8 + payload.length);
  frame[0] = stream;
  frame[4] = (payload.length >>> 24) & 0xff;
  frame[5] = (payload.length >>> 16) & 0xff;
  frame[6] = (payload.length >>> 8) & 0xff;
  frame[7] = payload.length & 0xff;
  frame.set(payload, 8);
  return frame;
};

const makeService = (overrides: Partial<Pick<ServicePlan, "command" | "entrypoint">> = {}): ServicePlan => ({
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: [
    "node",
    "-e",
    "console.log('lando-contract-ready'); setInterval(() => console.log('lando-contract-tick'), 250)",
  ],
  environment: {},
  appMount: {
    source: AbsolutePath.make("/tmp/lando-sdk-contract-myapp"),
    target: PortablePath.make("/app"),
    readOnly: false,
    excludes: [],
    includes: [],
    realization: "accelerated",
  },
  mounts: [
    {
      type: "bind",
      source: "/tmp/lando-sdk-cache",
      target: PortablePath.make("/cache"),
      readOnly: true,
      realization: "accelerated",
    },
  ],
  storage: [],
  endpoints: [{ port: 31080, protocol: "http", name: "http" }],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
  ...overrides,
});

const makePlan = (service = makeService()): AppPlan => ({
  id: appId,
  name: "My App",
  slug: "myapp",
  root: AbsolutePath.make("/tmp/lando-sdk-contract-myapp"),
  provider: providerId,
  services: { [serviceName]: service },
  routes: [],
  networks: [],
  stores: [],
  metadata,
  extensions: {},
});

const makeFakeApi = () => {
  const running = new Set<string>();
  const existing = new Set<string>();
  const execs = new Map<string, number>();
  const calls: DockerHttpRequest[] = [];

  const api: DockerApiClient = {
    info: Effect.succeed({}),
    request: (request) =>
      Effect.sync((): DockerHttpResponse => {
        calls.push(request);

        if (request.path === "/networks/create") {
          return { status: 201, body: "{}" };
        }
        if (request.path === "/networks/lando_bridge_network/connect") {
          return { status: 200, body: "{}" };
        }
        if (request.path === "/networks/lando-myapp" && request.method === "DELETE") {
          return { status: 204, body: "" };
        }
        if (request.path.startsWith("/exec/") && request.path.endsWith("/json") && request.method === "GET") {
          const execId = decodeURIComponent(request.path.slice("/exec/".length, -"/json".length));
          if (!execs.has(execId)) {
            return { status: 404, body: "" };
          }
          return { status: 200, body: JSON.stringify({ ExitCode: execs.get(execId) }) };
        }
        if (
          request.path.startsWith("/exec/") &&
          request.path.includes("/resize?") &&
          request.method === "POST"
        ) {
          return { status: 200, body: "" };
        }
        if (request.path.startsWith("/containers/create?name=")) {
          const name = decodeURIComponent(request.path.slice("/containers/create?name=".length));
          existing.add(name);
          return { status: 201, body: JSON.stringify({ Id: `${name}-id` }) };
        }
        if (request.path.endsWith("/exec") && request.method === "POST") {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/exec".length));
          if (!existing.has(name)) {
            return { status: 404, body: "" };
          }
          const execId = `${name}-exec`;
          execs.set(execId, 0);
          return { status: 201, body: JSON.stringify({ Id: execId }) };
        }
        if (request.path.endsWith("/start")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/start".length));
          existing.add(name);
          running.add(name);
          return { status: 204, body: "" };
        }
        if (request.path.endsWith("/stop")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/stop".length));
          const wasRunning = running.delete(name);
          return { status: wasRunning ? 204 : 304, body: "" };
        }
        if (request.path.endsWith("?force=true") && request.method === "DELETE") {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"?force=true".length));
          const existed = existing.delete(name);
          running.delete(name);
          return { status: existed ? 204 : 404, body: "" };
        }
        if (request.path.startsWith("/containers/") && request.path.endsWith("/json")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/json".length));
          if (!existing.has(name)) {
            return { status: 404, body: "" };
          }
          return {
            status: 200,
            body: JSON.stringify({
              Id: `${name}-id`,
              State: { Running: running.has(name), Status: running.has(name) ? "running" : "stopped" },
            }),
          };
        }

        return {
          status: 500,
          body: JSON.stringify({ error: `unhandled ${request.method} ${request.path}` }),
        };
      }),
    stream: (request) => {
      calls.push(request);
      if (request.path.startsWith("/exec/") && request.path.endsWith("/start")) {
        return Stream.fromIterable([attachFrame(1, "exec-ok\n")]);
      }
      if (request.path.includes("/logs?")) {
        return Stream.fromIterable([attachFrame(1, "2026-05-17T12:00:00.000Z ready\n")]);
      }
      return Stream.empty;
    },
  };

  return { api, calls };
};

interface FakeDockerApiHooks {
  readonly failStartFor?: ReadonlySet<string>;
  readonly failCreateFor?: ReadonlySet<string>;
  readonly startFailureBody?: string;
  readonly volumes?: Set<string>;
}

const makeFakeApiWithHooks = (hooks: FakeDockerApiHooks = {}) => {
  const running = new Set<string>();
  const existing = new Set<string>();
  const volumes = hooks.volumes ?? new Set<string>();
  const calls: DockerHttpRequest[] = [];

  const api: DockerApiClient = {
    info: Effect.succeed({}),
    request: (request) =>
      Effect.sync((): DockerHttpResponse => {
        calls.push(request);
        if (request.path === "/networks/create") {
          return { status: 201, body: "{}" };
        }
        if (request.path === "/networks/lando_bridge_network/connect") {
          return { status: 200, body: "{}" };
        }
        if (request.method === "DELETE" && request.path.startsWith("/networks/")) {
          return { status: 204, body: "" };
        }
        if (request.method === "DELETE" && request.path.startsWith("/volumes/")) {
          const volName = decodeURIComponent(request.path.slice("/volumes/".length));
          const deleted = volumes.delete(volName);
          return { status: deleted ? 204 : 404, body: "" };
        }
        if (request.path.startsWith("/containers/create?name=")) {
          const createdName = decodeURIComponent(request.path.slice("/containers/create?name=".length));
          if (hooks.failCreateFor?.has(createdName) === true) {
            return {
              status: 500,
              body: `forced create failure for ${createdName}: env DB_PASSWORD=hunter2 rejected`,
            };
          }
          if (existing.has(createdName)) {
            return { status: 409, body: "already exists" };
          }
          existing.add(createdName);
          return { status: 201, body: "{}" };
        }
        if (request.path.endsWith("/start")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/start".length));
          if (hooks.failStartFor?.has(name) === true) {
            return {
              status: 500,
              body: hooks.startFailureBody ?? `forced start failure for ${name}`,
            };
          }
          if (running.has(name)) {
            return { status: 304, body: "" };
          }
          running.add(name);
          return { status: 204, body: "" };
        }
        if (request.path.endsWith("/stop")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/stop".length));
          running.delete(name);
          return { status: 204, body: "" };
        }
        if (request.path.endsWith("?force=true") && request.method === "DELETE") {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"?force=true".length));
          const existed = existing.delete(name);
          running.delete(name);
          return { status: existed ? 204 : 404, body: "" };
        }
        if (request.path.startsWith("/containers/") && request.path.endsWith("/json")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/json".length));
          if (!existing.has(name)) {
            return { status: 404, body: "" };
          }
          return {
            status: 200,
            body: JSON.stringify({
              Id: `${name}-id`,
              State: { Running: running.has(name), Status: running.has(name) ? "running" : "stopped" },
            }),
          };
        }
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
    stream: (request) => {
      calls.push(request);
      return Stream.empty;
    },
  };

  return { api, calls, running, existing, volumes };
};

const dbServiceName = ServiceName.make("db");

const makeDbService = (): ServicePlan => ({
  name: dbServiceName,
  type: "postgres",
  provider: providerId,
  primary: false,
  artifact: { kind: "ref", ref: "postgres:16-alpine" },
  command: ["postgres"],
  environment: { DB_PASSWORD: "hunter2" },
  mounts: [],
  storage: [
    {
      store: "myapp_db_data",
      target: PortablePath.make("/var/lib/postgresql/data"),
      readOnly: false,
    },
  ],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const makeMultiServicePlan = (opts: { includeStores?: boolean } = {}): AppPlan => ({
  id: appId,
  name: "My App",
  slug: "myapp",
  root: AbsolutePath.make("/tmp/lando-sdk-contract-myapp"),
  provider: providerId,
  services: { [dbServiceName]: makeDbService(), [serviceName]: makeService() },
  routes: [],
  networks: [],
  stores: opts.includeStores ? [{ name: "myapp_db_data", scope: "app" as const }] : [],
  metadata,
  extensions: {},
});

describe("provider-docker RuntimeProvider contract", () => {
  test("flushes the final buffered chunk when a named-pipe chunked stream closes", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "provider-docker-npipe-"));
    const socketPath = path.join(tempDir, "docker.sock");
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.end(
          [
            "HTTP/1.1 200 OK",
            "Content-Type: text/plain",
            "Transfer-Encoding: chunked",
            "",
            "5\r\nhello",
          ].join("\r\n"),
        );
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      const client = makeDockerApiClient(`npipe:${socketPath}`);
      const body = await Effect.runPromise(
        client.stream({ method: "GET", path: "/logs" }).pipe(
          Stream.runCollect,
          Effect.map((chunks) => Array.from(chunks).map((chunk) => textDecoder.decode(chunk))),
        ),
      );

      expect(body).toEqual(["hello"]);
    } finally {
      server.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("runs the provider contract suite through the Docker Engine API", async () => {
    const fake = makeFakeApi();
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ platform: "linux", dockerApi: fake.api }))),
    );

    await Effect.runPromise(runProviderContract(provider));

    expect(provider.capabilities.bindMountPerformance).toBe("native");
    expect(provider.capabilities.sharedCrossAppNetwork).toBe(true);
    expect(fake.calls.some((call) => call.path === "/networks/create")).toBe(true);
    expect(fake.calls.some((call) => call.path === "/networks/lando-myapp")).toBe(true);
    expect(fake.calls.every((call) => call.path.startsWith("/"))).toBe(true);
  });

  test("fails closed for unsupported volume listing", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(makeProviderLayer({ platform: "linux", dockerApi: makeFakeApi().api })),
      ),
    );

    const exit = await Effect.runPromiseExit(provider.listVolumes({ app: appId }));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(exit.cause.toString()).toContain("ProviderUnavailableError");
    expect(exit.cause.toString()).toContain("listVolumes");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ProviderUnavailableError);
    }
  });

  test("covers apply, inspect, exec, logs, and destroy with a fake client", async () => {
    const fake = makeFakeApi();
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ dockerApi: fake.api }))),
    );
    const plan = makePlan(makeService({ command: "npm start", entrypoint: "docker-entrypoint.sh" }));

    await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: true })));
    const inspected = await Effect.runPromise(provider.inspect({ app: appId, service: serviceName }));
    const exec = await Effect.runPromise(
      provider.exec({ app: appId, service: serviceName }, { command: ["echo", "ok"] }),
    );
    const logs = await Effect.runPromise(
      provider.logs({ app: appId, service: serviceName }, { follow: false }).pipe(
        Stream.runCollect,
        Effect.map((chunks) => Array.from(chunks)),
      ),
    );
    await Effect.runPromise(provider.destroy({ app: appId }, { volumes: true }));

    expect(inspected.status).toBe("running");
    expect(exec).toEqual({ exitCode: 0, stdout: "exec-ok\n", stderr: "" });
    expect(logs).toEqual([
      {
        service: serviceName,
        stream: "stdout",
        line: "ready",
        timestamp: new Date("2026-05-17T12:00:00.000Z"),
      },
    ]);
    expect(
      fake.calls.find((call) => call.path === "/containers/create?name=lando-myapp-web")?.body,
    ).toMatchObject({
      Cmd: ["sh", "-lc", "npm start"],
      Entrypoint: ["docker-entrypoint.sh"],
      HostConfig: {
        Binds: ["My-App-web-app-mount:/app", "My-App-web-mount-0:/cache:ro"],
        PortBindings: { "31080/tcp": [{ HostIp: "127.0.0.1", HostPort: "31080" }] },
      },
      NetworkingConfig: {
        EndpointsConfig: {
          "lando-myapp": {},
        },
      },
    });
    expect(fake.calls.find((call) => call.path === "/networks/lando_bridge_network/connect")?.body).toEqual({
      Container: "lando-myapp-web",
      EndpointConfig: { Aliases: ["web.myapp.internal"] },
    });
    expect(fake.calls.filter((call) => call.path === "/networks/create").map((call) => call.body)).toEqual([
      { Name: "lando-myapp", Driver: "bridge", CheckDuplicate: true },
      { Name: "lando_bridge_network", Driver: "bridge", CheckDuplicate: true },
    ]);
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /networks/create",
      "POST /networks/create",
      "GET /containers/lando-myapp-web/json",
      "POST /containers/create?name=lando-myapp-web",
      "POST /networks/lando_bridge_network/connect",
      "POST /containers/lando-myapp-web/start",
      "GET /containers/lando-myapp-web/json",
      "POST /containers/lando-myapp-web/exec",
      "POST /exec/lando-myapp-web-exec/start",
      "GET /exec/lando-myapp-web-exec/json",
      "GET /containers/lando-myapp-web/logs?stdout=true&stderr=true&follow=false&timestamps=true",
      "POST /containers/lando-myapp-web/stop",
      "DELETE /containers/lando-myapp-web?force=true",
      "DELETE /networks/lando-myapp",
    ]);
  });

  test("passes TTY and inherited stdin settings into exec create/start", async () => {
    const fake = makeFakeApi();
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ dockerApi: fake.api }))),
    );
    const plan = makePlan(makeService());

    await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: true })));
    await Effect.runPromise(
      provider
        .execStream(
          { app: appId, service: serviceName },
          { command: ["sh", "-l"], stdin: "inherit", tty: true },
        )
        .pipe(Stream.runCollect, Effect.scoped),
    );

    const create = fake.calls.find((call) => call.path === "/containers/lando-myapp-web/exec");
    const start = fake.calls.find((call) => call.path === "/exec/lando-myapp-web-exec/start");
    expect(create?.body).toMatchObject({ AttachStdin: true, Tty: true });
    expect(start?.body).toMatchObject({ Tty: true });
  });

  test("emits raw stdout chunks for TTY exec streams and forwards stdin and terminal resize events", async () => {
    const fake = makeFakeApi();
    const stdinStream = (async function* () {
      yield textEncoder.encode("typed\n");
    })();
    fake.api.stream = (request) => {
      fake.calls.push(request);
      if (request.path.startsWith("/exec/") && request.path.endsWith("/start")) {
        return Stream.fromIterable([textEncoder.encode("raw-tty\n")]);
      }
      return Stream.empty;
    };
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ dockerApi: fake.api }))),
    );
    const plan = makePlan(makeService());

    await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: true })));
    const chunks = await Effect.runPromise(
      provider
        .execStream(
          { app: appId, service: serviceName },
          {
            command: ["sh", "-l"],
            stdin: "inherit",
            stdinStream,
            tty: true,
            terminalSize: { columns: 132, rows: 43 },
            terminalResize: Stream.fromIterable([{ columns: 100, rows: 20 }]),
          },
        )
        .pipe(Stream.runCollect, Effect.scoped),
    );

    const stdout = Array.from(chunks)
      .filter((chunk) => "kind" in chunk && chunk.kind === "stdout")
      .map((chunk) => ("chunk" in chunk ? textDecoder.decode(chunk.chunk) : ""))
      .join("");
    expect(stdout).toBe("raw-tty\n");
    expect(fake.calls.find((call) => call.path === "/exec/lando-myapp-web-exec/start")?.stdin).toBe(
      stdinStream,
    );
    expect(fake.calls.some((call) => call.path === "/exec/lando-myapp-web-exec/resize?h=43&w=132")).toBe(
      true,
    );
    expect(fake.calls.some((call) => call.path === "/exec/lando-myapp-web-exec/resize?h=20&w=100")).toBe(
      true,
    );
  });

  test("interrupts provider exec streams when the abort signal fires", async () => {
    const fake = makeFakeApi();
    const controller = new AbortController();
    fake.api.stream = (request) => {
      fake.calls.push(request);
      if (request.path.startsWith("/exec/") && request.path.endsWith("/start")) return Stream.never;
      return Stream.empty;
    };
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ dockerApi: fake.api }))),
    );
    const plan = makePlan(makeService());

    await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: true })));
    const chunks = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* provider
            .execStream(
              { app: appId, service: serviceName },
              { command: ["sh", "-l"], stdin: "inherit", tty: true, signal: controller.signal },
            )
            .pipe(Stream.runCollect, Effect.fork);
          yield* Effect.sleep("10 millis");
          controller.abort();
          return yield* Fiber.join(fiber);
        }),
      ),
    );

    expect(Array.from(chunks)).toEqual([]);
    expect(fake.calls.find((call) => call.path === "/exec/lando-myapp-web-exec/start")?.signal).toBe(
      controller.signal,
    );
  });

  test("decodes raw Docker log bytes", async () => {
    const fake = makeFakeApi();
    fake.api.stream = (request) => {
      fake.calls.push(request);
      if (request.path.includes("/logs?")) {
        return Stream.fromIterable([textEncoder.encode("2026-05-17T12:00:00.000Z raw ready\n")]);
      }
      return Stream.empty;
    };

    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ dockerApi: fake.api }))),
    );
    const plan = makePlan();

    await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: true })));
    const logs = await Effect.runPromise(
      provider.logs({ app: appId, service: serviceName }, { follow: false }).pipe(
        Stream.runCollect,
        Effect.map((chunks) => Array.from(chunks)),
      ),
    );

    expect(logs).toEqual([
      {
        service: serviceName,
        stream: "stdout",
        line: "raw ready",
        timestamp: new Date("2026-05-17T12:00:00.000Z"),
      },
    ]);
  });

  test("decodes split framed Docker log bytes", async () => {
    const fake = makeFakeApi();
    fake.api.stream = (request) => {
      fake.calls.push(request);
      if (request.path.includes("/logs?")) {
        const frame = attachFrame(1, "2026-05-17T12:00:00.000Z split ready\n");
        return Stream.fromIterable([frame.slice(0, 5), frame.slice(5)]);
      }
      return Stream.empty;
    };

    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ dockerApi: fake.api }))),
    );
    const plan = makePlan();

    await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: true })));
    const logs = await Effect.runPromise(
      provider.logs({ app: appId, service: serviceName }, { follow: false }).pipe(
        Stream.runCollect,
        Effect.map((chunks) => Array.from(chunks)),
      ),
    );

    expect(logs).toEqual([
      {
        service: serviceName,
        stream: "stdout",
        line: "split ready",
        timestamp: new Date("2026-05-17T12:00:00.000Z"),
      },
    ]);
  });

  test("declares the Linux Docker Engine capability matrix", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({ platform: "linux", env: {}, dockerApi: { info: Effect.succeed({}) } }),
        ),
      ),
    );

    expect(provider.capabilities).toEqual(linuxDockerCapabilities);
    expect(provider.capabilities.bindMountPerformance).not.toBe("slow");
    expect(provider.capabilities.sharedCrossAppNetwork).toBe(true);
  });

  test("emits a compose document for provider-owned orchestration state", () => {
    const compose = renderCompose(makePlan());

    expect(compose).toContain('image: "node:22-alpine"');
    expect(compose).toContain('"127.0.0.1:31080:31080/tcp"');
    expect(compose).toContain('name: "lando-myapp"');
  });

  test("emits compose networks from typed NetworkingPlan", () => {
    const compose = renderCompose({
      ...makePlan(),
      networking: {
        perAppBridge: { name: "custom-app-net", driver: "bridge" },
        sharedNetworkMembership: {
          name: "custom-shared-net",
          aliases: { [serviceName]: ["web.custom.internal"] },
        },
      },
    });

    expect(compose).toContain("      custom-app-net:");
    expect(compose).toContain(
      '      custom-shared-net:\n        aliases:\n          - "web.custom.internal"',
    );
    expect(compose).toContain('  custom-app-net:\n    name: "custom-app-net"');
    expect(compose).toContain('  custom-shared-net:\n    name: "custom-shared-net"\n    external: true');
    expect(compose).not.toContain("lando_bridge_network");
  });

  test("omits the shared compose network for per-app-only NetworkingPlan", () => {
    const compose = renderCompose({
      ...makePlan(),
      networking: { perAppBridge: { name: "custom-app-net", driver: "bridge" } },
    });

    expect(compose).toContain("      custom-app-net:");
    expect(compose).toContain('  custom-app-net:\n    name: "custom-app-net"');
    expect(compose).not.toContain("aliases:");
    expect(compose).not.toContain("lando_bridge_network");
  });

  test.skipIf(!process.env.LANDO_TEST_DOCKER_SOCKET && !process.env.DOCKER_HOST)(
    "runs the provider contract suite against a live Docker Engine socket",
    async () => {
      const dockerHost = process.env.LANDO_TEST_DOCKER_SOCKET ?? process.env.DOCKER_HOST;
      expect(dockerHost).toBeTruthy();

      const provider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(makeProviderLayer({ dockerApi: makeDockerApiClient(dockerHost ?? "") })),
        ),
      );

      await Effect.runPromise(runProviderContract(provider));
    },
    60_000,
  );

  test("covers Windows Docker Desktop apply, inspect, exec, logs, and destroy with a fake client", async () => {
    const fake = makeFakeApi();
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "win32",
            env: {},
            dockerApi: fake.api,
          }),
        ),
      ),
    );
    const plan = makePlan(makeService({ command: "npm start", entrypoint: "docker-entrypoint.sh" }));

    expect(provider.capabilities.bindMountPerformance).toBe("slow");
    expect(provider.capabilities.sharedCrossAppNetwork).toBe(true);

    await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: true })));
    const inspected = await Effect.runPromise(provider.inspect({ app: appId, service: serviceName }));
    const exec = await Effect.runPromise(
      provider.exec({ app: appId, service: serviceName }, { command: ["echo", "ok"] }),
    );
    const logs = await Effect.runPromise(
      provider.logs({ app: appId, service: serviceName }, { follow: false }).pipe(
        Stream.runCollect,
        Effect.map((chunks) => Array.from(chunks)),
      ),
    );
    await Effect.runPromise(provider.destroy({ app: appId }, { volumes: true }));

    expect(inspected.status).toBe("running");
    expect(exec).toEqual({ exitCode: 0, stdout: "exec-ok\n", stderr: "" });
    expect(logs).toEqual([
      {
        service: serviceName,
        stream: "stdout",
        line: "ready",
        timestamp: new Date("2026-05-17T12:00:00.000Z"),
      },
    ]);
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /networks/create",
      "POST /networks/create",
      "GET /containers/lando-myapp-web/json",
      "POST /containers/create?name=lando-myapp-web",
      "POST /networks/lando_bridge_network/connect",
      "POST /containers/lando-myapp-web/start",
      "GET /containers/lando-myapp-web/json",
      "POST /containers/lando-myapp-web/exec",
      "POST /exec/lando-myapp-web-exec/start",
      "GET /exec/lando-myapp-web-exec/json",
      "GET /containers/lando-myapp-web/logs?stdout=true&stderr=true&follow=false&timestamps=true",
      "POST /containers/lando-myapp-web/stop",
      "DELETE /containers/lando-myapp-web?force=true",
      "DELETE /networks/lando-myapp",
    ]);
  });

  test.skipIf(
    process.platform !== "win32" ||
      (!process.env.LANDO_TEST_WINDOWS_DOCKER_SOCKET && !process.env.DOCKER_HOST),
  )(
    "runs the provider contract suite against a live Windows Docker Desktop socket",
    async () => {
      const dockerHost = process.env.LANDO_TEST_WINDOWS_DOCKER_SOCKET ?? process.env.DOCKER_HOST;
      expect(dockerHost).toBeTruthy();

      const provider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(
            makeProviderLayer({
              platform: "win32",
              dockerApi: makeDockerApiClient(dockerHost ?? ""),
            }),
          ),
        ),
      );

      expect(provider.capabilities.bindMountPerformance).toBe("slow");
      await Effect.runPromise(runProviderContract(provider));
    },
    60_000,
  );

  test("matrix: covers linux / darwin / win32 via fake Docker API", async () => {
    const buildProvider = (platform: "linux" | "darwin" | "win32") =>
      RuntimeProvider.pipe(
        Effect.provide(makeProviderLayer({ platform, env: {}, dockerApi: makeFakeApi().api })),
      );

    const report = await Effect.runPromise(
      runProviderContractMatrix({
        providerName: "@lando/provider-docker",
        cells: [
          { platform: "linux", supported: true, factory: () => buildProvider("linux") },
          { platform: "darwin", supported: true, factory: () => buildProvider("darwin") },
          { platform: "win32", supported: true, factory: () => buildProvider("win32") },
          {
            platform: "wsl",
            supported: false,
            skipReason: "provider-docker targets native Windows, not WSL",
          },
        ],
      }),
    );

    expect(report.providerName).toBe("@lando/provider-docker");
    expect(report.results.map((r) => `${r.platform}:${r.outcome}`)).toEqual([
      "linux:passed",
      "darwin:passed",
      "win32:passed",
      "wsl:skipped",
    ]);
  });

  test("rolls back network when the first service start fails after network create", async () => {
    const fake = makeFakeApiWithHooks({ failStartFor: new Set(["lando-myapp-db"]) });
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ platform: "linux", dockerApi: fake.api }))),
    );
    const plan = makeMultiServicePlan();

    const exit = await Effect.runPromiseExit(Effect.scoped(provider.apply(plan, { reconcile: true })));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(fake.existing.size).toBe(0);
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/networks/"))).toBe(
      true,
    );
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/volumes/"))).toBe(
      false,
    );
  });

  test("rolls back the first service and network when the second service start fails", async () => {
    const fake = makeFakeApiWithHooks({ failStartFor: new Set(["lando-myapp-web"]) });
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ platform: "linux", dockerApi: fake.api }))),
    );
    const plan = makeMultiServicePlan();

    const exit = await Effect.runPromiseExit(Effect.scoped(provider.apply(plan, { reconcile: true })));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(fake.existing.size).toBe(0);
    expect(fake.running.size).toBe(0);
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.includes("lando-myapp-db"))).toBe(
      true,
    );
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.includes("lando-myapp-web"))).toBe(
      true,
    );
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/networks/"))).toBe(
      true,
    );
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/volumes/"))).toBe(
      false,
    );
  });

  test("cleans up already-started services when abort signal is observed", async () => {
    const inner = makeFakeApiWithHooks({});
    const controller = new AbortController();
    let startCallCount = 0;
    const wrappedApi: DockerApiClient = {
      info: inner.api.info,
      request: (req) => {
        const request = inner.api.request;
        if (request === undefined) {
          throw new Error("expected request handler");
        }
        if (req.path.endsWith("/start")) {
          startCallCount++;
          const result = request(req);
          if (startCallCount === 1) {
            return result.pipe(Effect.tap(() => Effect.sync(() => controller.abort())));
          }
          return result;
        }
        return request(req);
      },
      stream: inner.api.stream,
    };

    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ platform: "linux", dockerApi: wrappedApi }))),
    );
    const plan = makeMultiServicePlan();

    const exit = await Effect.runPromiseExit(
      Effect.scoped(provider.apply(plan, { reconcile: true, signal: controller.signal })),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(inner.running.size).toBe(0);
    expect(inner.calls.some((call) => call.path.includes("/stop"))).toBe(true);
  });

  test("failure errors include providerId, operation, remediation, and redacted details", async () => {
    const fake = makeFakeApiWithHooks({ failCreateFor: new Set(["lando-myapp-db"]) });
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ platform: "linux", dockerApi: fake.api }))),
    );
    const plan = makeMultiServicePlan();

    const exit = await Effect.runPromiseExit(Effect.scoped(provider.apply(plan, { reconcile: true })));

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const failures = Array.from(Cause.failures(exit.cause));
    const startError = failures.find(
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        (error as { _tag: string })._tag === "ServiceStartError",
    ) as ServiceStartError | undefined;
    expect(startError).toBeDefined();
    if (startError === undefined) return;
    expect(startError.providerId).toBe("docker");
    expect(startError.operation).toBe("apply");
    expect(startError.service).toBe("db");
    expect(typeof startError.remediation).toBe("string");
    expect(startError.remediation).toMatch(/lando destroy/u);
    const details = startError.details as { status: number; body: string } | undefined;
    expect(details?.status).toBe(500);
    expect(details?.body).toContain("[REDACTED]");
    expect(details?.body).not.toContain("hunter2");
  });

  test("surfaces the Docker API failure reason in the error message", async () => {
    const fake = makeFakeApiWithHooks({
      failStartFor: new Set(["lando-myapp-db"]),
      startFailureBody: JSON.stringify({
        message:
          "driver failed programming external connectivity: bind 0.0.0.0:80: address already in use; APP_TOKEN=hunter2",
      }),
    });
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ platform: "linux", dockerApi: fake.api }))),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(provider.apply(makeMultiServicePlan(), { reconcile: true })),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const startError = Array.from(Cause.failures(exit.cause)).find(
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        (error as { _tag: string })._tag === "ServiceStartError",
    ) as ServiceStartError | undefined;
    expect(startError).toBeDefined();
    if (startError === undefined) return;
    expect(startError.message).toContain("Docker container start failed with HTTP 500.");
    expect(startError.message).toContain("bind 0.0.0.0:80: address already in use");
    expect(startError.message).not.toContain("hunter2");
    expect(startError.message).toContain("APP_TOKEN=[REDACTED]");
  });

  test("destroy with volumes:true removes app-scoped volumes; default preserves them", async () => {
    const plan = makeMultiServicePlan({ includeStores: true });

    const fake1 = makeFakeApiWithHooks({ volumes: new Set(["myapp_db_data"]) });
    const provider1 = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ platform: "linux", dockerApi: fake1.api }))),
    );
    await Effect.runPromise(Effect.scoped(provider1.apply(plan, { reconcile: true })));
    await Effect.runPromise(provider1.destroy({ app: appId }, { volumes: false }));

    expect(fake1.volumes.has("myapp_db_data")).toBe(true);
    expect(fake1.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/volumes/"))).toBe(
      false,
    );

    const fake2 = makeFakeApiWithHooks({ volumes: new Set(["myapp_db_data"]) });
    const provider2 = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ platform: "linux", dockerApi: fake2.api }))),
    );
    await Effect.runPromise(Effect.scoped(provider2.apply(plan, { reconcile: true })));
    await Effect.runPromise(provider2.destroy({ app: appId }, { volumes: true }));

    expect(fake2.volumes.has("myapp_db_data")).toBe(false);
    expect(fake2.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/volumes/"))).toBe(
      true,
    );
  });
});
