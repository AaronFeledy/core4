import { expect, test } from "bun:test";
import { mergeLandofiles, mergeValues, routeInputObject } from "@lando/sdk/landofile";
import { RouteObjectInput, ServiceConfig } from "@lando/sdk/schema";

const hostname = "{{ app.name }}.{{ proxy.defaultDomain }}";

test.each(["bad host", "a..test", "https://a.test", "{{ incomplete", "{{ app.name }} bad.test"])(
  "keeps invalid route text unkeyed: %s",
  (invalid) => {
    // Given invalid syntax outside any complete template span.
    const local = [{ hostname: invalid }];
    // When the declared route rule cannot project an identity.
    const merged = mergeValues(ServiceConfig, [{ hostname: "base.test" }], local, ["routes"]);
    // Then its unkeyed fallback still replaces the list.
    expect(merged).toEqual(local);
  },
);

test.each([
  { routes: ["web.a.test", "web.b.test"] },
  { routes: [{ hostname: "web.a.test" }, { hostname: "web.b.test" }] },
])("appends a distinct path regardless of inherited route spelling %j", ({ routes }) => {
  // Given two inherited routes and a local path-specific route.
  const base = { services: { web: { routes } } };
  const local = { services: { web: { routes: [{ hostname: "web.a.test", pathPrefix: "/api" }] } } };
  // When the layers merge.
  const result: unknown = mergeLandofiles([base, local]);
  // Then both inherited routes survive alongside the new path.
  expect(result).toEqual({ services: { web: { routes: [...routes, ...local.services.web.routes] } } });
});

test.each([{ baseRoute: "WEB.A.TEST:80" }, { baseRoute: { hostname: "WEB.A.TEST", endpoint: 80 } }])(
  "matches hostname case without using the backend as identity %j",
  ({ baseRoute }) => {
    // Given the same route with different hostname case and backend.
    const base = { services: { web: { routes: [baseRoute] } } };
    const local = { services: { web: { routes: [{ hostname: "web.a.test", endpoint: 8080 }] } } };
    // When the layers merge.
    const result = mergeLandofiles([base, local]);
    // Then a sparse promoted route carries the local backend.
    expect(result).toEqual(local);
  },
);

test("preserves http when an https overlay matches an inherited both route", () => {
  // Given a two-scheme route and an https-only override.
  const base = { proxy: { web: [{ hostname: "web.a.test", scheme: "both", endpoint: 80 }] } };
  const local = { proxy: { web: [{ hostname: "web.a.test", scheme: "https", endpoint: 8080 }] } };
  // When the layers merge.
  const result = mergeLandofiles([base, local]);
  // Then the http backend stays inherited.
  expect(result).toEqual({
    proxy: {
      web: [
        { hostname: "web.a.test", scheme: "http", endpoint: 80 },
        { hostname: "web.a.test", scheme: "https", endpoint: 8080 },
      ],
    },
  });
});

test("preserves same-layer duplicate route groups and never mutates inputs", () => {
  const base = { proxy: { web: ["a.test", "a.test:80", "b.test"] } };
  const local = {
    proxy: {
      web: [
        { hostname: "a.test", endpoint: 8080 },
        { hostname: "a.test", endpoint: 9090 },
      ],
    },
  };
  const before = structuredClone([base, local]);
  expect(mergeLandofiles([base, local])).toEqual({ proxy: { web: [...local.proxy.web, "b.test"] } });
  expect([base, local]).toEqual(before);
});

test("an overlay both updates both atomic route identities", () => {
  expect(
    mergeValues(
      ServiceConfig,
      [
        { hostname: "a.test", scheme: "http", endpoint: 80 },
        { hostname: "a.test", scheme: "https", endpoint: 443 },
      ],
      [{ hostname: "a.test", scheme: "both", endpoint: 8080 }],
      ["routes"],
    ),
  ).toEqual([
    { hostname: "a.test", scheme: "http", endpoint: 8080 },
    { hostname: "a.test", scheme: "https", endpoint: 8080 },
  ]);
});

test("retains an unrelated inherited templated both route", () => {
  // Given a recipe route and an unrelated local hostname.
  const inherited = { hostname, scheme: "both" };
  const local = { hostname: "extra.test" };
  // When the service's route layers merge before materialization.
  const merged = mergeValues(ServiceConfig, [inherited], [local], ["routes"]);
  // Then the authored recipe route stays alongside the local route.
  expect(merged).toEqual([inherited, local]);
});

test("merges identical templated object identities without dropping inherited fields", () => {
  // Given identical literal hostname and path expressions across layers.
  const inherited = { hostname, pathPrefix: "{{ app.path }}", endpoint: 80 };
  const local = {
    hostname,
    pathPrefix: "{{ app.path }}",
    filters: [{ type: "stripPrefix", prefix: "/api" }],
  };
  // When the local layer adds filters.
  const merged = mergeValues(ServiceConfig, [inherited], [local], ["routes"]);
  // Then one route keeps its backend and gains the local filters.
  expect(merged).toEqual([{ ...inherited, filters: local.filters }]);
});

test("appends a distinct path under a templated hostname", () => {
  // Given a templated root route and a local path-specific route.
  const inherited = { hostname };
  const local = { hostname, pathPrefix: "/api" };
  // When the layers merge.
  const merged = mergeValues(ServiceConfig, [inherited], [local], ["routes"]);
  // Then both path identities remain.
  expect(merged).toEqual([inherited, local]);
});

test.each([
  { host: "{{ app.name }}.${DOMAIN}", path: "/{{ app.path }}/api" },
  { host: "${secret:HOST}", path: "/${PATH}" },
  { host: '{{ app.host ?? "a/b:test" }}.TEST', path: '/{{ app.path ?? "x:y/z" }}' },
])("matches templated shorthand against its object spelling %j", ({ host, path }) => {
  // Given whitespace and grammar punctuation contained only inside template spans.
  const shorthand = `${host}:8080${path}`;
  const local = { hostname: host, pathPrefix: path, filters: [{ type: "addPrefix", prefix: "/local" }] };
  // When the matching overlay promotes the shorthand.
  const merged = mergeValues(ServiceConfig, [shorthand], [local], ["routes"]);
  // Then the original slices and inherited backend survive promotion.
  expect(merged).toEqual([{ ...local, endpoint: 8080 }]);
});

test("promotes template shorthand without replacing original text with parser masks", () => {
  // Given expression spans that contain whitespace, slashes, and colons.
  const shorthand = '{{ app.host ?? "a/b:c" }}.${DOMAIN}:8080/{{ app.path }}';
  // When the merger asks for the sparse object spelling.
  const promoted = routeInputObject(shorthand);
  // Then all authored template text is unchanged.
  expect(promoted).toEqual({
    hostname: '{{ app.host ?? "a/b:c" }}.${DOMAIN}',
    endpoint: 8080,
    pathPrefix: "/{{ app.path }}",
  });
});

test("keeps templated hostname case literal instead of conflating different expressions", () => {
  // Given case-sensitive expression names on otherwise equal routes.
  const inherited = { hostname: "{{ APP.name }}.TEST" };
  const local = { hostname: "{{ app.name }}.TEST" };
  // When the route layers merge.
  const merged = mergeValues(ServiceConfig, [inherited], [local], ["routes"]);
  // Then distinct literal expressions are distinct identities.
  expect(merged).toEqual([inherited, local]);
});

test.each([
  { field: "dependsOn", key: "service" },
  { field: "endpoints", key: "name" },
  { field: "ports", key: "name" },
  { field: "logs", key: "id" },
])("matches literal template identities in $field", ({ field, key }) => {
  // Given a matching template identity and a second inherited entry.
  const inherited = [{ [key]: "${IDENTITY}", inherited: true }, { [key]: "stable" }];
  const local = [{ [key]: "${IDENTITY}", local: true }];
  // When the collection's declared rule merges the layers.
  const merged = mergeValues(ServiceConfig, inherited, local, [field]);
  // Then the match deep-merges without replacing the collection.
  expect(merged).toEqual([{ [key]: "${IDENTITY}", inherited: true, local: true }, { [key]: "stable" }]);
});

test.each(["name", "type"])("matches a literal template filter %s", (key) => {
  // Given a named or unnamed template filter identity.
  const inherited = [{ [key]: "{{ filter.identity }}", inherited: true }, { [key]: "stable" }];
  const local = [{ [key]: "{{ filter.identity }}", local: true }];
  // When route filters merge.
  const merged = mergeValues(RouteObjectInput, inherited, local, ["filters"]);
  // Then the matching filter updates and the unrelated filter stays.
  expect(merged).toEqual([
    { [key]: "{{ filter.identity }}", inherited: true, local: true },
    { [key]: "stable" },
  ]);
});

test("keeps an untouched non-template both route in its authored form", () => {
  // Given a both route with no scheme identity mentioned by the local layer.
  const inherited = { hostname: "recipe.test", scheme: "both", endpoint: 80 };
  const local = { hostname: "extra.test", scheme: "both" };
  const before = structuredClone([inherited, local]);
  // When the local layer adds its route.
  const merged = mergeValues(ServiceConfig, [inherited], [local], ["routes"]);
  // Then neither authored entry is split or mutated.
  expect(merged).toEqual([inherited, local]);
  expect([inherited, local]).toEqual(before);
});

test("appends an unmatched both overlay as one authored entry", () => {
  // Given a single-scheme inherited route and an unrelated both overlay.
  const inherited = { hostname: "base.test", scheme: "https" };
  const local = { hostname: "extra.test", scheme: "both" };
  // When the route lists merge.
  const merged = mergeValues(ServiceConfig, [inherited], [local], ["routes"]);
  // Then the appended entry retains both.
  expect(merged).toEqual([inherited, local]);
});

test("appends only the unmatched part of a partially matched both overlay", () => {
  // Given inherited HTTPS and a both overlay for the same hostname.
  const inherited = { hostname: "base.test", scheme: "https", endpoint: 443 };
  const local = { hostname: "base.test", scheme: "both", endpoint: 8080 };
  // When the HTTPS identity matches but HTTP does not.
  const merged = mergeValues(ServiceConfig, [inherited], [local], ["routes"]);
  // Then HTTPS updates in place and only the new HTTP part appends.
  expect(merged).toEqual([
    { ...local, scheme: "https" },
    { ...local, scheme: "http" },
  ]);
});

test("retains untouched duplicate both entries for planner validation", () => {
  // Given duplicate inherited route groups and one HTTPS overlay.
  const inherited = [
    { hostname: "duplicate.test", scheme: "both", endpoint: 80 },
    { hostname: "duplicate.test", scheme: "both", endpoint: 81 },
  ];
  const local = { hostname: "duplicate.test", scheme: "https", endpoint: 8080 };
  // When only the first group's HTTPS identity is matched.
  const merged = mergeValues(ServiceConfig, inherited, [local], ["routes"]);
  // Then the matched group splits and the untouched duplicate remains authored.
  expect(merged).toEqual([{ ...inherited[0], scheme: "http" }, local, inherited[1]]);
});
