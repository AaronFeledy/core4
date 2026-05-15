import { describe, expect, test } from "bun:test";
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
import { AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";
import { runProviderContract } from "@lando/sdk/test";

const makeFakeApi = () => {
  const running = new Set<string>();
  const existing = new Set<string>();
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
        if (request.path.startsWith("/containers/create?name=")) {
          const name = decodeURIComponent(request.path.slice("/containers/create?name=".length));
          existing.add(name);
          return { status: 201, body: JSON.stringify({ Id: `${name}-id` }) };
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
        if (request.path.endsWith("/json")) {
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
      return Stream.empty;
    },
  };

  return { api, calls };
};

describe("provider-docker RuntimeProvider contract", () => {
  test("passes the SDK provider contract suite through the Docker Engine HTTP API", async () => {
    const fake = makeFakeApi();
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ dockerApi: fake.api }))),
    );

    await Effect.runPromise(runProviderContract(provider));

    expect(provider.capabilities.bindMountPerformance).toBe(process.platform === "linux" ? "native" : "none");
    expect(provider.capabilities.sharedCrossAppNetwork).toBe(false);
    expect(fake.calls.some((call) => call.path === "/networks/create")).toBe(true);
    expect(fake.calls.some((call) => call.path === "/networks/lando-myapp")).toBe(true);
    expect(fake.calls.every((call) => call.path.startsWith("/"))).toBe(true);
  });

  test("declares the Linux Docker Engine capability matrix", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ dockerApi: { info: Effect.succeed({}) } }))),
    );

    expect(provider.capabilities).toEqual(linuxDockerCapabilities);
    expect(provider.capabilities.bindMountPerformance).not.toBe("slow");
    expect(provider.capabilities.sharedCrossAppNetwork).toBe(false);
  });

  test("emits a compose document for provider-owned orchestration state", () => {
    const compose = renderCompose({
      id: AppId.make("myapp"),
      name: "My App",
      slug: "myapp",
      root: AbsolutePath.make("/tmp/lando-sdk-contract-myapp"),
      provider: ProviderId.make("docker"),
      services: {
        [ServiceName.make("web")]: {
          name: ServiceName.make("web"),
          type: "node",
          provider: ProviderId.make("docker"),
          primary: true,
          artifact: { kind: "ref", ref: "node:22-alpine" },
          command: ["node", "-e", "setInterval(() => {}, 1000)"],
          environment: {},
          mounts: [],
          storage: [],
          endpoints: [{ port: 31080, protocol: "http", name: "http" }],
          routes: [],
          dependsOn: [],
          hostAliases: [],
          metadata: {
            resolvedAt: DateTime.unsafeMake("2026-05-10T18:51:00Z"),
            source: "provider-docker.test",
            runtime: 4,
          },
          extensions: {},
        },
      },
      routes: [],
      networks: [],
      stores: [],
      metadata: {
        resolvedAt: DateTime.unsafeMake("2026-05-10T18:51:00Z"),
        source: "provider-docker.test",
        runtime: 4,
      },
      extensions: {},
    });

    expect(compose).toContain('image: "node:22-alpine"');
    expect(compose).toContain('"127.0.0.1:31080:31080/tcp"');
    expect(compose).toContain('name: "lando-myapp"');
  });

  test.skipIf(!process.env.LANDO_TEST_DOCKER_SOCKET && !process.env.DOCKER_HOST)(
    "passes the SDK provider contract suite against a live Docker Engine socket",
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
});
