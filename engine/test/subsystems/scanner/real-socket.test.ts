import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId, type ScanPlan, ServiceName } from "@lando/sdk/schema";
import { RuntimeProvider, type RuntimeProviderShape, UrlScanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { HttpClientLive } from "@lando/http-client/live";
import { UrlScannerLive } from "../../../src/subsystems/scanner/live.ts";

const web = ServiceName.make("web");
const appId = AppId.make("real-scan");

let server: ReturnType<typeof Bun.serve> | undefined;
let port = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/healthz"
        ? new Response(null, { status: 204 })
        : new Response("boom", { status: 500 }),
  });
  port = server.port ?? 0;
});

afterAll(() => {
  server?.stop(true);
});

const providerAt = (hostPort: number): RuntimeProviderShape => ({
  ...TestRuntimeProvider,
  list: () =>
    Effect.succeed([
      {
        app: appId,
        service: web,
        providerId: ProviderId.make(TestRuntimeProvider.id),
        status: "running",
        endpoints: [
          {
            _tag: "published" as const,
            protocol: "http" as const,
            port: 80,
            publication: {},
            materialization: { bindAddress: "127.0.0.1", hostPort },
          },
        ],
      },
    ]),
});

const planWith = (scanner: ScanPlan): AppPlan =>
  ({
    id: appId,
    name: "real-scan",
    slug: "real-scan",
    root: AbsolutePath.make("/tmp/real-scan"),
    provider: ProviderId.make(TestRuntimeProvider.id),
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata: { resolvedAt: DateTime.unsafeMake(0), source: "real-socket.test", runtime: 4 },
    extensions: {},
    services: { [web]: { name: web, scanner } },
  }) as unknown as AppPlan;

const scanAgainst = (hostPort: number, scanner: ScanPlan) =>
  Effect.runPromise(
    Effect.flatMap(UrlScanner, (service) => service.scan(appId, { plan: planWith(scanner) })).pipe(
      Effect.provide(UrlScannerLive),
      Effect.provide(Layer.succeed(RuntimeProvider, providerAt(hostPort))),
      Effect.provide(HttpClientLive),
    ),
  );

describe("post-start URL scan against a real socket", () => {
  test("green when the resolved path answers with an accepted status", async () => {
    // Given: a real server answering 204 only on /healthz.
    const result = await scanAgainst(port, {
      enabled: true,
      path: "/healthz",
      okCodes: [204],
      retries: 0,
      timeoutMs: 5000,
    });
    // Then
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]?.url).toBe(`http://localhost:${port}/healthz`);
    expect(result.endpoints[0]?.outcome).toBe("green");
    expect(result.endpoints[0]?.reachable).toBe(true);
  });

  test("yellow with the real status when the answer is outside the accepted set", async () => {
    const result = await scanAgainst(port, {
      enabled: true,
      path: "/",
      okCodes: [],
      retries: 0,
      timeoutMs: 5000,
    });
    expect(result.endpoints[0]?.outcome).toBe("yellow");
    expect(result.endpoints[0]?.detail).toContain("HTTP 500");
  });

  test("red when nothing listens, bounded by the resolved deadline", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const deadPort = closed.port ?? 0;
    closed.stop(true);
    const started = Date.now();
    const result = await scanAgainst(deadPort, {
      enabled: true,
      path: "/",
      okCodes: [],
      retries: 1,
      timeoutMs: 5000,
    });
    expect(result.endpoints[0]?.outcome).toBe("red");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("a disabled service is never requested", async () => {
    const result = await scanAgainst(port, {
      enabled: false,
      path: "/healthz",
      okCodes: [204],
      retries: 0,
      timeoutMs: 5000,
    });
    expect(result.endpoints).toEqual([]);
  });
});
