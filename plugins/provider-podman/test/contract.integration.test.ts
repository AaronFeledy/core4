import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { DateTime } from "effect";

import type { PodmanHttpRequest, PodmanHttpResponse } from "@lando/provider-lando";
import { type PodmanApiClient, makePodmanApiClient, makeProviderLayer } from "@lando/provider-podman";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type PlanMetadata,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";
import { runProviderContract, runProviderContractMatrix } from "@lando/sdk/test";

const providerId = ProviderId.make("podman");
const appId = AppId.make("persisted-podman");
const serviceName = ServiceName.make("web");

const metadata: PlanMetadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-27T00:00:00Z"),
  source: "provider-podman contract test",
  runtime: 4,
};

const servicePlan: ServicePlan = {
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "server.js"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const plan: AppPlan = {
  id: appId,
  name: "Persisted Podman",
  slug: "persisted-podman",
  root: AbsolutePath.make("/tmp/lando-provider-podman-persisted"),
  provider: providerId,
  services: { [serviceName]: servicePlan },
  routes: [],
  networks: [],
  stores: [],
  metadata,
  extensions: {},
};

const makeFakeApi = () => {
  const running = new Set<string>();
  const existing = new Set<string>();
  const calls: PodmanHttpRequest[] = [];

  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    request: (request) =>
      Effect.sync((): PodmanHttpResponse => {
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
  };

  return { api, calls };
};

describe("provider-podman RuntimeProvider contract", () => {
  test("passes the SDK provider contract suite", async () => {
    const fake = makeFakeApi();
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(makeProviderLayer({ podmanApi: fake.api, platform: "linux", env: {} })),
      ),
    );

    expect(provider.id).toBe("podman");
    expect(provider.capabilities.bindMountPerformance).toBe("native");

    await Effect.runPromise(runProviderContract(provider));
    expect(fake.calls.some((call) => call.path === "/networks/create")).toBe(true);
    expect(fake.calls.some((call) => call.path === "/networks/lando-myapp")).toBe(true);
  });

  test("persists applied plans for follow-up CLI invocations", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-provider-podman-state-"));
    try {
      const firstFake = makeFakeApi();
      const firstProvider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(
            makeProviderLayer({ podmanApi: firstFake.api, platform: "linux", env: {}, stateDir }),
          ),
        ),
      );
      await Effect.runPromise(firstProvider.apply(plan, { reconcile: true }));

      const secondFake = makeFakeApi();
      const secondProvider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(
            makeProviderLayer({ podmanApi: secondFake.api, platform: "linux", env: {}, stateDir }),
          ),
        ),
      );
      const snapshot = await Effect.runPromise(secondProvider.inspect({ app: appId, service: serviceName }));

      expect(snapshot.providerId).toBe("podman");
      expect(secondFake.calls.some((call) => call.path.endsWith("/json"))).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test.skipIf(!process.env.LANDO_TEST_PODMAN_SOCKET)(
    "passes the SDK provider contract suite against a live Podman socket",
    async () => {
      const socketPath = process.env.LANDO_TEST_PODMAN_SOCKET;
      expect(socketPath).toBeTruthy();

      const provider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(
            makeProviderLayer({
              podmanApi: makePodmanApiClient(socketPath ?? ""),
              platform: "linux",
            }),
          ),
        ),
      );

      await Effect.runPromise(runProviderContract(provider));
    },
    60_000,
  );

  test("matrix: covers linux / darwin / win32 via fake Podman API", async () => {
    const buildProvider = (platform: "linux" | "darwin" | "win32") =>
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            podmanApi: makeFakeApi().api,
            platform,
            env: {},
          }),
        ),
      );

    const report = await Effect.runPromise(
      runProviderContractMatrix({
        providerName: "@lando/provider-podman",
        cells: [
          { platform: "linux", supported: true, factory: () => buildProvider("linux") },
          { platform: "darwin", supported: true, factory: () => buildProvider("darwin") },
          { platform: "win32", supported: true, factory: () => buildProvider("win32") },
        ],
      }),
    );

    expect(report.providerName).toBe("@lando/provider-podman");
    expect(report.results.map((r) => `${r.platform}:${r.outcome}`)).toEqual([
      "linux:passed",
      "darwin:passed",
      "win32:passed",
    ]);
  });
});
