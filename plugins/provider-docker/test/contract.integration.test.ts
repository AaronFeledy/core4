import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DateTime, Effect, Stream } from "effect";

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
import { runProviderContract } from "@lando/sdk/test";

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
  command: ["node", "-e", "setInterval(() => {}, 1000)"],
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
    expect(provider.capabilities.sharedCrossAppNetwork).toBe(false);
    expect(fake.calls.some((call) => call.path === "/networks/create")).toBe(true);
    expect(fake.calls.some((call) => call.path === "/networks/lando-myapp")).toBe(true);
    expect(fake.calls.every((call) => call.path.startsWith("/"))).toBe(true);
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
        Binds: ["/tmp/lando-sdk-contract-myapp:/app", "/tmp/lando-sdk-cache:/cache:ro"],
        PortBindings: { "31080/tcp": [{ HostIp: "127.0.0.1", HostPort: "31080" }] },
      },
    });
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /networks/create",
      "GET /containers/lando-myapp-web/json",
      "POST /containers/create?name=lando-myapp-web",
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
    expect(provider.capabilities.sharedCrossAppNetwork).toBe(false);
  });

  test("emits a compose document for provider-owned orchestration state", () => {
    const compose = renderCompose(makePlan());

    expect(compose).toContain('image: "node:22-alpine"');
    expect(compose).toContain('"127.0.0.1:31080:31080/tcp"');
    expect(compose).toContain('name: "lando-myapp"');
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
    expect(provider.capabilities.sharedCrossAppNetwork).toBe(false);

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
      "GET /containers/lando-myapp-web/json",
      "POST /containers/create?name=lando-myapp-web",
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
});
