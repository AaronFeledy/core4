import { expect, test } from "bun:test";
import { invokeOperation } from "@lando/core/cli/operations";
import type { RouteEvidence, RoutePlan } from "@lando/sdk/schema";
import { AppPlanner, LandofileService, RouterService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { type OpenAppOptions, openApp } from "../../../src/cli/commands/open";
import { commandServices, makePlan, route, silentEventLayer } from "../../_support/host-proxy-open-fixtures";

const wildcard = route({ hostname: "*.x", scheme: "https", service: "web" });
const exact = { ...route({ hostname: "admin.x", scheme: "https", service: "admin" }), priority: 65539 };
const tied = route({ hostname: "*-a.x", scheme: "https", service: "api" });
const patternAtPath = {
  ...route({ hostname: "*.x", scheme: "https", service: "api" }),
  pathPrefix: "/api",
  priority: 6,
};

type Routes = readonly RoutePlan[];
type Observation = {
  readonly unpublished?: readonly string[];
  readonly inactive?: readonly string[];
  readonly failedInspection?: string;
  readonly unavailable?: boolean;
  readonly disabled?: boolean;
  readonly publicationHostname?: string;
  readonly publicationScheme?: "http" | "https";
};

const run = (routes: Routes, options: OpenAppOptions, state: Observation = {}) => {
  const plan = {
    ...makePlan([...routes], [...new Set(routes.map((route) => String(route.service)))]),
    ...(state.disabled ? { router: { enabled: false } } : {}),
  };
  const inspected: string[] = [];
  const routerQueries: string[][] = [];
  const provider = {
    ...TestRuntimeProvider,
    inspect: ({ app, service }: Parameters<typeof TestRuntimeProvider.inspect>[0]) => {
      inspected.push(service);
      if (service === state.failedInspection) return Effect.die(new Error(`Cannot inspect ${service}`));
      return Effect.succeed({
        app,
        service,
        providerId: plan.provider,
        status: state.inactive?.includes(service) ? ("exited" as const) : ("running" as const),
        publications: {
          status: "present" as const,
          bindings: [{ port: 80, transport: "tcp" as const, bindAddress: "127.0.0.1", hostPort: 49152 }],
        },
      });
    },
  };
  const publications = routes.flatMap((route) => {
    if (state.unpublished?.includes(route.hostname)) return [];
    const schemes = route.scheme === "both" ? (["http", "https"] as const) : [route.scheme];
    return schemes.map((scheme) => ({
      route,
      authority: {
        hostname: route === routes[0] ? (state.publicationHostname ?? route.hostname) : route.hostname,
        scheme: route === routes[0] ? (state.publicationScheme ?? scheme) : scheme,
        port: scheme === "http" ? 8080 : 8443,
      },
    }));
  });
  const evidence: RouteEvidence = {
    configuredAuthorities: publications.map(({ authority }) => authority),
    observation: state.unavailable ? { status: "unknown" } : { status: "present", publications },
  };
  const services = Layer.mergeAll(
    commandServices(silentEventLayer(), 8443, provider),
    Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.die("must use existing plan") })),
    Layer.succeed(LandofileService, LandofileService.of({ discover: Effect.die("must use existing plan") })),
    Layer.succeed(
      RuntimeProviderRegistry,
      makeTestRuntimeProviderRegistry({ select: () => Effect.succeed(provider) }),
    ),
    Layer.succeed(
      RouterService,
      RouterService.of({
        ...makeTestRouterService(),
        status: Effect.die("router status does not prove route publication"),
        observeRoutes: (_owner, routes) => {
          routerQueries.push(routes.map(({ hostname }) => hostname));
          return Effect.succeed(evidence);
        },
      }),
    ),
  );
  const app = { kind: "user", id: plan.id, root: plan.root } as const;
  return {
    routerQueries,
    inspected,
    result: Effect.runPromise(
      invokeOperation(openApp({ print: true, ...options }, { app, plan, root: plan.root })).pipe(
        Effect.provide(services),
      ),
    ),
  };
};

test.each(["/docs/../admin", "/docs/%2e%2E/admin"])(
  "refuses a winning exact route when a browser would rewrite %s",
  async (pathPrefix) => {
    const { result } = run([{ ...exact, pathPrefix }, wildcard], { hostname: "admin.x" });
    expect(await result).toMatchObject({
      ok: false,
      error: {
        _tag: "OpenTargetUnresolvedError",
        app: "myapp",
        services: ["admin", "web"],
        message: expect.stringContaining(pathPrefix),
      },
    });
  },
);

test.each([{ publicationHostname: "another.x" }, { publicationScheme: "http" as const }])(
  "does not let an authority naming the wrong host or scheme shadow a published pattern: %j",
  async (state) => {
    const { result } = run([exact, wildcard], { hostname: "admin.x" }, state);
    expect(await result).toMatchObject({
      ok: true,
      value: { targets: [{ service: "web", url: "https://admin.x:8443" }] },
    });
  },
);

test.each([
  ["exact hostname", [{ ...exact, hostname: "app.x" }], "app.x", "admin", "https://app.x:8443", {}],
  ["wildcard hostname", [wildcard], "docs.x", "web", "https://docs.x:8443", {}],
  ["case-insensitive hostname", [wildcard], "DOCS.x", "web", "https://docs.x:8443", {}],
  [
    "HTTP-only pattern with a path",
    [{ ...wildcard, hostname: "lets.*.x", scheme: "http", pathPrefix: "/hello" }],
    "lets.go.x",
    "web",
    "http://lets.go.x:8080/hello",
    {},
  ],
  [
    "shadowed patterns",
    [
      { ...exact, scheme: "both" },
      { ...wildcard, scheme: "both" },
    ],
    "admin.x",
    "admin",
    "https://admin.x:8443",
    {},
  ],
  [
    "exact path wins over pattern root",
    [{ ...exact, pathPrefix: "/dash" }, wildcard],
    "admin.x",
    "admin",
    "https://admin.x:8443/dash",
    {},
  ],
  [
    "exact /admin wins over pattern /",
    [
      { ...wildcard, pathPrefix: "/" },
      { ...exact, pathPrefix: "/admin" },
    ],
    "admin.x",
    "admin",
    "https://admin.x:8443/admin",
    {},
  ],
  [
    "exact HTTPS without inspecting the HTTP pattern backend",
    [exact, { ...wildcard, scheme: "http" }],
    "admin.x",
    "admin",
    "https://admin.x:8443",
    { failedInspection: "web" },
  ],
  [
    "pattern serves an unpublished exact hostname",
    [exact, wildcard],
    "admin.x",
    "web",
    "https://admin.x:8443",
    { unpublished: ["admin.x"] },
  ],
  [
    "a tie within one service",
    [wildcard, { ...wildcard, hostname: "*-a.x" }],
    "b-a.x",
    "web",
    "https://b-a.x:8443",
    {},
  ],
  [
    "distinct paths in route-table order",
    [wildcard, patternAtPath],
    "docs.x",
    "web",
    "https://docs.x:8443",
    {},
  ],
] as const)(
  "opens %s using the URL the router serves",
  async (_label, routes, hostname, service, url, state: Observation) => {
    const { result, inspected } = run(routes, { hostname }, state);
    expect(await result).toMatchObject({
      ok: true,
      value: {
        launch: "printed",
        targets: [
          {
            service,
            hostname: hostname.toLowerCase(),
            url,
            scheme: url.startsWith("https:") ? "https" : "http",
          },
        ],
      },
    });
    if (state.failedInspection !== undefined) expect(inspected).not.toContain(state.failedInspection);
  },
);

test.each([
  [
    "disabled router",
    [wildcard],
    "docs.x",
    { disabled: true },
    ["router is disabled"],
    "enabled: true",
    0,
    [],
  ],
  ["pattern cannot cross labels", [wildcard], "a.b.x", {}, ["No route", "*.x"], "lando start", 0, []],
  [
    "a service name is not a hostname selector",
    [wildcard],
    "web",
    {},
    ["No route"],
    "lando open --service web",
    0,
    [],
  ],
  [
    "unknown publication",
    [wildcard],
    "docs.x",
    { unavailable: true },
    ["*.x", "not serving"],
    "lando info",
    1,
    [],
  ],
  [
    "inactive pattern backend",
    [wildcard],
    "docs.x",
    { inactive: ["web"] },
    ["*.x", "service web is not running"],
    "lando open docs.x",
    1,
    ["web"],
  ],
  [
    "inactive exact backend and dual-scheme pattern",
    [exact, { ...wildcard, scheme: "both" }],
    "admin.x",
    { inactive: ["admin"] },
    ["Route admin.x", "service admin is not running"],
    "lando open admin.x",
    1,
    ["admin"],
  ],
  [
    "inactive exact HTTPS backend and active HTTP pattern",
    [exact, { ...wildcard, scheme: "http" }],
    "admin.x",
    { inactive: ["admin"] },
    ["Route admin.x", "service admin is not running"],
    "lando open admin.x",
    1,
    ["admin"],
  ],
  [
    "equal-priority routes for different services",
    [wildcard, tied],
    "b-a.x",
    {},
    ["https://b-a.x:8443", "web and api", "*.x, *-a.x"],
    "longer path prefix",
    1,
    ["web", "api"],
  ],
  [
    "a browser rewrites a numeric host",
    [{ ...exact, hostname: "127.1" }],
    "127.1",
    {},
    ["Browsers cannot open 127.1"],
    "last label",
    1,
    ["admin"],
  ],
  [
    "a browser rejects a numeric TLD",
    [{ ...wildcard, hostname: "*.123", scheme: "http" }],
    "web.123",
    {},
    ["Browsers cannot open web.123"],
    "last label",
    1,
    ["web"],
  ],
] as const)(
  "diagnoses %s without opening another URL",
  async (_label, routes, hostname, state, message, remediation, queries, inspections) => {
    const { result, routerQueries, inspected } = run(routes, { hostname }, state);
    const outcome = await result;
    expect(outcome).toMatchObject({
      ok: false,
      error: {
        _tag: "OpenTargetUnresolvedError",
        app: "myapp",
        services: [...new Set(routes.map(({ service }) => service))],
      },
    });
    if (outcome.ok) throw new Error("expected hostname resolution failure");
    expect(outcome.error).toHaveProperty("remediation", expect.stringContaining(remediation));
    for (const fragment of message)
      expect(outcome.error).toHaveProperty("message", expect.stringContaining(fragment));
    expect(routerQueries).toHaveLength(queries);
    expect(inspected).toEqual([...inspections]);
  },
);

test.each([
  [{ hostname: "*.x", service: "web", all: true }, "service", "flag", "conflict"],
  [{ hostname: "docs.x", all: true }, "all", "flag", "conflict"],
  [{ hostname: "*.x" }, "hostname", "arg", "pattern"],
  [{ hostname: "https://user:s3cr3tpass@*.x.test" }, "hostname", "arg", "pattern"],
  [{ hostname: "https://user:s3cr3tpass@x.test" }, "hostname", "arg", "invalid"],
  [{ hostname: "bücher.x" }, "hostname", "arg", "invalid"],
  [{ hostname: "under_score.x" }, "hostname", "arg", "invalid"],
] as const)(
  "rejects invalid open input %j before contacting the router or provider",
  async (input, field, kind, reason) => {
    const { result, routerQueries, inspected } = run([wildcard], input);
    const outcome = await result;
    expect(outcome).toMatchObject({
      ok: false,
      error: { _tag: "CommandInputValidationError", target: "app:open", field, kind, reason },
    });
    expect(JSON.stringify(outcome)).not.toContain("s3cr3tpass");
    expect(routerQueries).toEqual([]);
    expect(inspected).toEqual([]);
  },
);
