import { expect, test } from "bun:test";
import type { RoutePlan } from "@lando/sdk/schema";
import { Effect } from "effect";
import {
  app,
  demoNs7,
  demoRouterHttp,
  demoService,
  liveGraph,
  makeObserveFixture,
  route,
} from "./observe-routes-fixture.ts";
import { routeOwner } from "./route-owner-fixture.ts";

test.each([
  { rule: 'Host("other.example.test") && PathPrefix("/api")' },
  { rule: 'Host("demo.example.test") && PathPrefix("/wrong")' },
  { rule: 'Host("demo.example.test")' },
  { priority: 1 },
  { service: `${demoNs7}@docker` },
  { entryPoints: ["websecure"] },
  { using: [] },
  { tls: {} },
  { status: "disabled" },
  { status: "warning" },
  { error: ["bad middleware"] },
  { middlewares: ["unrequested@file"] },
])("does not publish a route when the live rule differs (%j)", async (patch) => {
  const graph = liveGraph();
  const fixture = makeObserveFixture({
    ...graph,
    routers: { [demoRouterHttp]: { ...graph.routers[demoRouterHttp], ...patch } },
  });
  const evidence = await Effect.runPromise(
    fixture.service.observeRoutes(app, [{ ...route, scheme: "http" }]),
  );
  expect(evidence.observation).toEqual({ status: "missing" });
  expect(fixture.mutations).toEqual([]);
});

test.each(["route-other-7-http@file", `${demoNs7}-http@docker`, "route-demo-evil-http@file"])(
  "does not trust an unowned router %s",
  async (name) => {
    const graph = liveGraph();
    const fixture = makeObserveFixture({
      ...graph,
      routers: { [name]: graph.routers[demoRouterHttp] },
    });
    const evidence = await Effect.runPromise(
      fixture.service.observeRoutes(app, [{ ...route, scheme: "http" }]),
    );
    expect(evidence.observation).toEqual({ status: "missing" });
  },
);

test("does not confuse app IDs sharing a prefix", async () => {
  const fixture = makeObserveFixture();
  const evidence = await Effect.runPromise(fixture.service.observeRoutes(routeOwner("dem"), [route]));
  expect(evidence.observation).toEqual({ status: "missing" });
});

test.each([
  { status: "disabled" },
  { error: ["backend error"] },
  { loadBalancer: { servers: [{ url: "https://web.demo.internal:8080" }] } },
  { loadBalancer: { servers: [{ url: "http://web.other.internal:8080" }] } },
  { loadBalancer: { servers: [{ url: "http://web.demo.internal:9999" }] } },
  { loadBalancer: { servers: [] } },
])("does not publish an unusable or wrong backend (%j)", async (patch) => {
  const graph = liveGraph();
  const fixture = makeObserveFixture({
    ...graph,
    services: { [demoService]: { ...graph.services[demoService], ...patch } },
  });
  const evidence = await Effect.runPromise(fixture.service.observeRoutes(app, [route]));
  expect(evidence.observation).toEqual({ status: "missing" });
});

const middlewareCases = [
  {
    filter: { type: "stripPrefix", prefix: "/api" },
    config: { stripPrefix: { prefixes: ["/api"], forceSlash: true } },
  },
  { filter: { type: "addPrefix", prefix: "/v2" }, config: { addPrefix: { prefix: "/v2" } } },
  {
    filter: { type: "requestHeader", header: "X-App", value: "yes" },
    config: { headers: { customRequestHeaders: { "X-App": "yes" } } },
  },
  {
    filter: { type: "responseHeader", header: "X-App", value: "yes" },
    config: { headers: { customResponseHeaders: { "X-App": "yes" } } },
  },
  {
    filter: { type: "redirect", to: "/new" },
    config: { redirectRegex: { regex: "^.*$", replacement: "/new" } },
  },
  {
    filter: { type: "redirect", to: "/new", permanent: false },
    config: { redirectRegex: { regex: "^.*$", replacement: "/new" } },
  },
  {
    filter: { type: "redirect", to: "/new", permanent: true },
    config: { redirectRegex: { regex: "^.*$", replacement: "/new", permanent: true } },
  },
] satisfies ReadonlyArray<{
  readonly filter: NonNullable<RoutePlan["filters"]>[number];
  readonly config: unknown;
}>;

test.each(middlewareCases)(
  "matches effective middleware with provider defaults (%j)",
  async ({ filter, config }) => {
    const graph = liveGraph();
    const middleware = `${demoNs7}-f0-${filter.type}`;
    const fixture = makeObserveFixture({
      ...graph,
      routers: { [demoRouterHttp]: { ...graph.routers[demoRouterHttp], middlewares: [middleware] } },
      middlewares: {
        [`${middleware}@file`]: { ...config, status: "enabled", usedBy: [demoRouterHttp] },
      },
    });
    const requested: RoutePlan = { ...route, scheme: "http", filters: [filter] };
    const evidence = await Effect.runPromise(fixture.service.observeRoutes(app, [requested]));
    expect(evidence.observation.status).toBe("present");
    expect(fixture.mutations).toEqual([]);
  },
);

test.each([
  { addPrefix: { prefix: "/wrong" }, status: "enabled" },
  { addPrefix: { prefix: "/v2" }, status: "disabled" },
  { addPrefix: { prefix: "/v2" }, status: "enabled", error: ["bad"] },
  { addPrefix: { prefix: "/v2" }, redirectScheme: { scheme: "https" }, status: "enabled" },
])("rejects changed middleware behavior (%j)", async (middlewareConfig) => {
  const graph = liveGraph();
  const fixture = makeObserveFixture({
    ...graph,
    routers: {
      [demoRouterHttp]: {
        ...graph.routers[demoRouterHttp],
        middlewares: [`${demoNs7}-f0-addPrefix@file`],
      },
    },
    middlewares: { [`${demoNs7}-f0-addPrefix@file`]: middlewareConfig },
  });
  const evidence = await Effect.runPromise(
    fixture.service.observeRoutes(app, [
      { ...route, scheme: "http", filters: [{ type: "addPrefix", prefix: "/v2" }] },
    ]),
  );
  expect(evidence.observation).toEqual({ status: "missing" });
});

test("matches IPv6 backend authorities without discarding the requested path", async () => {
  const graph = liveGraph();
  const fixture = makeObserveFixture({
    ...graph,
    services: {
      [demoService]: { status: "enabled", loadBalancer: { servers: [{ url: "http://[::1]:8080" }] } },
    },
  });
  const requested = { ...route, backend: { ...route.backend, host: "::1" } };
  const evidence = await Effect.runPromise(fixture.service.observeRoutes(app, [requested]));
  expect(evidence.observation).toMatchObject({
    status: "present",
    publications: [{ route: { pathPrefix: "/api" } }, { route: { pathPrefix: "/api" } }],
  });
});
