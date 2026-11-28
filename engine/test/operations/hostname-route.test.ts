import { expect, test } from "bun:test";
import { type RouteEvidence, type RoutePlan, ServiceName } from "@lando/sdk/schema";
import { hostnameCandidates, publishedRouteRules } from "../../src/operations/hostname-route.ts";
import { routePriority } from "../../src/planner/route-identity.ts";

type Protocol = "http" | "https";
const ports = { http: 8080, https: 8443 } as const;
const route = (
  hostname: string,
  scheme: RoutePlan["scheme"],
  options: { readonly service?: string; readonly pathPrefix?: string } = {},
): RoutePlan => {
  const service = ServiceName.make(options.service ?? "web");
  const planned: RoutePlan = {
    hostname,
    scheme,
    service,
    priority: 2,
    backend: { service, protocol: "http", port: 80 },
    ...(options.pathPrefix === undefined ? {} : { pathPrefix: options.pathPrefix }),
  };
  return { ...planned, priority: routePriority(planned) };
};

const publication = (route: RoutePlan, scheme: Protocol, port: number = ports[scheme]) => ({
  route,
  authority: { scheme, port, hostname: route.hostname },
});

const evidenceFor = (routes: readonly RoutePlan[]): RouteEvidence => ({
  configuredAuthorities: [],
  observation: {
    status: "present",
    publications: routes.flatMap((route) =>
      (route.scheme === "both" ? (["http", "https"] as const) : [route.scheme]).map((scheme) =>
        publication(route, scheme),
      ),
    ),
  },
});

interface CandidateCase {
  readonly scenario: string;
  readonly hostname: string;
  readonly routes: readonly RoutePlan[];
  readonly evidence?: (routes: readonly RoutePlan[]) => RouteEvidence | undefined;
  readonly expected: readonly (readonly [number, Protocol, number, readonly number[]])[];
  readonly urls?: readonly string[];
}

const cases: readonly CandidateCase[] = [
  {
    scenario: "serves an exact HTTPS hostname",
    hostname: "app.x",
    routes: [route("app.x", "https")],
    expected: [[0, "https", 8443, [0]]],
    urls: ["https://app.x:8443"],
  },
  ...["docs.x", "DOCS.x"].map(
    (hostname): CandidateCase => ({
      scenario: `serves ${hostname} through a wildcard`,
      hostname,
      routes: [route("*.x", "https")],
      expected: [[0, "https", 8443, [0]]],
      urls: ["https://docs.x:8443"],
    }),
  ),
  {
    scenario: "keeps the path of a deep wildcard HTTP route",
    hostname: "lets.go.x",
    routes: [route("lets.*.x", "http", { pathPrefix: "/hello" })],
    expected: [[0, "http", 8080, [0]]],
    urls: ["http://lets.go.x:8080/hello"],
  },
  {
    scenario: "shadows patterns on each scheme served by the exact route",
    hostname: "admin.x",
    routes: [route("*.x", "both"), route("admin.x", "both", { service: "admin" })],
    expected: [
      [1, "https", 8443, [1]],
      [1, "http", 8080, [1]],
    ],
  },
  ...["/dash", "/admin"].map(
    (pathPrefix): CandidateCase => ({
      scenario: `prefers exact ${pathPrefix} without shadowing the pattern at the root`,
      hostname: "admin.x",
      routes: [
        pathPrefix === "/admin" ? route("*.x", "https", { pathPrefix: "/" }) : route("*.x", "https"),
        route("admin.x", "https", { service: "admin", pathPrefix }),
      ],
      expected: [
        [1, "https", 8443, [1]],
        [0, "https", 8443, [0]],
      ],
      urls: [
        `https://admin.x:8443${pathPrefix}`,
        pathPrefix === "/admin" ? "https://admin.x:8443/" : "https://admin.x:8443",
      ],
    }),
  ),
  {
    scenario: "keeps the exact HTTPS and unshadowed pattern HTTP candidates for later state selection",
    hostname: "admin.x",
    routes: [route("admin.x", "https", { service: "admin" }), route("*.x", "both")],
    expected: [
      [0, "https", 8443, [0]],
      [1, "http", 8080, [1]],
    ],
  },
  {
    scenario: "orders exact HTTP before pattern HTTPS and pattern HTTPS before earlier pattern HTTP",
    hostname: "admin.x",
    routes: [
      route("*.x", "http"),
      route("a*.x", "https"),
      route("admin.x", "http", { pathPrefix: "/admin" }),
    ],
    expected: [
      [2, "http", 8080, [2]],
      [1, "https", 8443, [1]],
      [0, "http", 8080, [0]],
    ],
  },
  {
    scenario: "does not let an unpublished exact route shadow a published pattern",
    hostname: "admin.x",
    routes: [route("admin.x", "https", { service: "admin" }), route("*.x", "https")],
    evidence: (routes) => evidenceFor(routes.slice(1)),
    expected: [[1, "https", 8443, [1]]],
    urls: ["https://admin.x:8443"],
  },
  ...["api", "web"].map(
    (service): CandidateCase => ({
      scenario: `preserves equal-priority ties when the second pattern serves ${service}`,
      hostname: "b-a.x",
      routes: [route("*.x", "https"), route("*-a.x", "https", { service })],
      evidence: (routes) => evidenceFor(routes.toReversed()),
      expected: [
        [0, "https", 8443, [0, 1]],
        [1, "https", 8443, [0, 1]],
      ],
      urls: ["https://b-a.x:8443", "https://b-a.x:8443"],
    }),
  ),
  {
    scenario: "keeps root and scoped patterns in route-table order",
    hostname: "docs.x",
    routes: [route("*.x", "https"), route("*.x", "https", { service: "api", pathPrefix: "/api" })],
    expected: [
      [0, "https", 8443, [0]],
      [1, "https", 8443, [1]],
    ],
    urls: ["https://docs.x:8443", "https://docs.x:8443/api"],
  },
  {
    scenario: "ignores configured-only authority when observation is unknown",
    hostname: "docs.x",
    routes: [route("*.x", "https")],
    evidence: () => ({
      configuredAuthorities: [{ hostname: "*.x", scheme: "https", port: 8443 }],
      observation: { status: "unknown" },
    }),
    expected: [],
  },
  {
    scenario: "has no candidates without route evidence",
    hostname: "docs.x",
    routes: [route("*.x", "https")],
    evidence: () => undefined,
    expected: [],
  },
  {
    scenario: "does not match a wildcard across labels",
    hostname: "a.b.x",
    routes: [route("*.x", "https")],
    expected: [],
  },
  {
    scenario: "leaves browser normalization of an exact hostname to the caller",
    hostname: "127.1",
    routes: [route("127.1", "https")],
    expected: [[0, "https", 8443, [0]]],
    urls: ["https://127.1:8443"],
  },
  {
    scenario: "leaves browser validation of a substituted pattern hostname to the caller",
    hostname: "web.123",
    routes: [route("*.123", "http")],
    expected: [[0, "http", 8080, [0]]],
    urls: ["http://web.123:8080"],
  },
];

test.each(cases)("$scenario", ({ hostname, routes, evidence, expected, urls }) => {
  const candidates = hostnameCandidates(
    hostname,
    publishedRouteRules(routes, evidence === undefined ? evidenceFor(routes) : evidence(routes)),
  );

  expect<CandidateCase["expected"]>(
    candidates.map(({ rule, top }) => [
      rule.order,
      rule.protocol,
      rule.port,
      top.map(({ order }) => order).sort((a, b) => a - b),
    ]),
  ).toEqual(expected);
  if (urls !== undefined) expect<readonly string[]>(candidates.map(({ url }) => url)).toEqual(urls);
});

test("uses the observed port, drops stale and duplicate publications, and orders ports numerically", () => {
  const pattern = route("*.x", "https");
  const exact = route("admin.x", "https", { service: "admin" });
  const routes = [pattern, exact];
  const matchingCopy = { ...pattern, hostname: "*.X" };
  const evidence: RouteEvidence = {
    configuredAuthorities: [],
    observation: {
      status: "present",
      publications: [
        publication(pattern, "https", 9843),
        publication(matchingCopy, "https", 443),
        publication(matchingCopy, "https", 443),
        publication(pattern, "https", 8443),
        publication(exact, "https", 8443),
        publication({ ...exact, backend: { ...exact.backend, port: 81 } }, "https", 9843),
      ],
    },
  };

  const candidates = hostnameCandidates("admin.x", publishedRouteRules(routes, evidence));

  expect(candidates.map(({ url, rule, top }) => [url, rule.order, top.map(({ order }) => order)])).toEqual([
    ["https://admin.x:8443", 1, [1]],
    ["https://admin.x", 0, [0]],
    ["https://admin.x:9843", 0, [0]],
  ]);
});

test("uses a plain path prefix, not path segments, to determine the top rule", () => {
  const routes = [
    route("*.x", "https", { pathPrefix: "/api-v2" }),
    route("admin.x", "https", { pathPrefix: "/api" }),
  ];

  const candidates = hostnameCandidates("admin.x", publishedRouteRules(routes, evidenceFor(routes)));

  expect(candidates.map(({ url }) => url)).toEqual(["https://admin.x:8443/api"]);
});
