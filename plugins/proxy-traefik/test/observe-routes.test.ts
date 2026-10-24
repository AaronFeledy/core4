import { expect, test } from "bun:test";
import { Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { HttpClientError, TransportError } from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { acquisitionStateFile, defaultDomainFile } from "../src/proxy-paths.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { acquisition, app, liveGraph, makeObserveFixture, route } from "./observe-routes-fixture.ts";

test("observes an owned live graph with one GET, independent of requested subset indices", async () => {
  const fixture = makeObserveFixture();
  const evidence = await Effect.runPromise(fixture.service.observeRoutes(app, [route]));
  expect(evidence).toEqual({
    configuredAuthorities: [
      { hostname: route.hostname, scheme: "http", port: 38080 },
      { hostname: route.hostname, scheme: "https", port: 38443 },
    ],
    observation: {
      status: "present",
      publications: [
        { route, authority: { hostname: route.hostname, scheme: "http", port: 38080 } },
        { route, authority: { hostname: route.hostname, scheme: "https", port: 38443 } },
      ],
    },
  });
  expect(fixture.requests).toEqual([
    { method: "GET", url: "http://traefik.example.test:38080/api/rawdata", host: undefined },
  ]);
  expect(fixture.mutations).toEqual([]);
});

test.each(
  [
    {},
    null,
    [],
    { routers: {} },
    { routers: [], services: {} },
    { routers: { bad: null }, services: {} },
    { routers: { "route-demo-7-http@file": {} }, services: {} },
  ].map((payload) => ({ payload })),
)("does not call an invalid or absent graph known-empty (%j)", async ({ payload }) => {
  const fixture = makeObserveFixture(payload);
  const evidence = await Effect.runPromise(fixture.service.observeRoutes(app, [route]));
  expect(evidence.observation).toEqual({ status: "unknown" });
  expect(evidence.configuredAuthorities).toHaveLength(2);
  expect(fixture.mutations).toEqual([]);
});

test("reports missing only with a valid graph and proven ingress", async () => {
  const fixture = makeObserveFixture({ routers: {}, services: {} });
  const evidence = await Effect.runPromise(fixture.service.observeRoutes(app, [route]));
  expect(evidence.observation).toEqual({ status: "missing" });
  expect(fixture.mutations).toEqual([]);
});

test("retains configured addresses when the API is dead without leaking client errors", async () => {
  const fixture = makeObserveFixture();
  const service = makeTraefikRouterService({
    ...fixture.dependencies,
    httpClient: HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError({
          reason: new TransportError({
            request,
            cause: "sensitive-client-canary",
            description: "sensitive-client-canary",
          }),
        }),
      ),
    ),
  });
  const evidence = await Effect.runPromise(service.observeRoutes(app, [route]));
  expect(evidence.observation).toEqual({ status: "unknown" });
  expect(evidence.configuredAuthorities).toHaveLength(2);
  expect(JSON.stringify(evidence)).not.toContain("sensitive-client-canary");
  expect(fixture.mutations).toEqual([]);
});

test.each(["not-json-sensitive-canary", '{"routers": "sensitive-api-canary"}'])(
  "contains no response bytes in malformed API evidence (%s)",
  async (body) => {
    const fixture = makeObserveFixture();
    const service = makeTraefikRouterService({
      ...fixture.dependencies,
      httpClient: HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(body, { headers: { "content-type": "application/json" } }),
          ),
        ),
      ),
    });
    const evidence = await Effect.runPromise(service.observeRoutes(app, [route]));
    expect(evidence.observation).toEqual({ status: "unknown" });
    expect(JSON.stringify(evidence)).not.toContain("canary");
    expect(fixture.mutations).toEqual([]);
  },
);

test("retains configured addresses when the API returns an error", async () => {
  const fixture = makeObserveFixture();
  const service = makeTraefikRouterService({
    ...fixture.dependencies,
    httpClient: HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("secret-error", { status: 503 }))),
    ),
  });
  const evidence = await Effect.runPromise(service.observeRoutes(app, [route]));
  expect(evidence.observation).toEqual({ status: "unknown" });
  expect(evidence.configuredAuthorities).toHaveLength(2);
  expect(JSON.stringify(evidence)).not.toContain("secret-error");
  expect(fixture.mutations).toEqual([]);
});

test("leaves port assignments pending when no acquisition is known", async () => {
  const fixture = makeObserveFixture();
  fixture.files.delete(acquisitionStateFile(fixture.paths));
  const evidence = await Effect.runPromise(fixture.service.observeRoutes(app, [route]));
  expect(evidence).toEqual({ configuredAuthorities: [], observation: { status: "unknown" } });
  expect(fixture.requests).toEqual([]);
  expect(fixture.mutations).toEqual([]);
});

test("does not trust a live-shaped API without owned published ingress", async () => {
  const fixture = makeObserveFixture();
  const service = makeTraefikRouterService({
    ...fixture.dependencies,
    globalApp: { ...fixture.dependencies.globalApp, ownedPublishPorts: () => Effect.succeed([]) },
  });
  const evidence = await Effect.runPromise(service.observeRoutes(app, [route]));
  expect(evidence.observation).toEqual({ status: "unknown" });
  expect(evidence.configuredAuthorities).toHaveLength(2);
  expect(fixture.requests).toEqual([]);
  expect(fixture.mutations).toEqual([]);
});

test.each(["linux", "darwin", "win32", "wsl"] as const)(
  "proves helper ingress read-only on %s with IPv6",
  async (platform) => {
    const fixture = makeObserveFixture();
    const paths = { ...fixture.paths, platform };
    fixture.files.set(defaultDomainFile(paths), "example.test");
    fixture.files.set(
      acquisitionStateFile(paths),
      JSON.stringify({
        ...acquisition,
        mode: "socket-helper",
        httpPort: 80,
        httpsPort: 443,
        bindHttpPort: 38080,
        bindHttpsPort: 38443,
        fingerprint: { ...acquisition.fingerprint, bindAddress: "::" },
      }),
    );
    const service = makeTraefikRouterService({ ...fixture.dependencies, paths });
    const evidence = await Effect.runPromise(service.observeRoutes(app, [route]));
    expect(evidence.observation.status).toBe(platform === "win32" ? "unknown" : "present");
    expect(fixture.ownedRequests).toEqual([[38080, 38443]]);
    expect(fixture.requests[0]?.url).toBe("http://traefik.example.test/api/rawdata");
    expect(fixture.probes).toEqual([
      ["::1", 80, "http"],
      ["::1", 443, "https"],
    ]);
    expect(fixture.mutations).toEqual([]);
  },
);

test("retains configured ingress without claiming absence for an unproven scheme", async () => {
  const fixture = makeObserveFixture();
  const service = makeTraefikRouterService({
    ...fixture.dependencies,
    probeForward: (_host, _port, scheme) =>
      Effect.succeed({ kind: scheme === "http" ? "success" : "failure" }),
  });
  const evidence = await Effect.runPromise(service.observeRoutes(app, [route]));
  expect(evidence.observation).toEqual({ status: "unknown" });
  expect(evidence.configuredAuthorities).toHaveLength(2);
  expect(fixture.mutations).toEqual([]);
});

test("returns unknown rather than missing when all ingress probes fail", async () => {
  const fixture = makeObserveFixture(liveGraph());
  const service = makeTraefikRouterService({
    ...fixture.dependencies,
    probeForward: () => Effect.succeed({ kind: "failure" }),
  });
  const evidence = await Effect.runPromise(service.observeRoutes(app, [route]));
  expect(evidence.observation).toEqual({ status: "unknown" });
  expect(fixture.mutations).toEqual([]);
});
