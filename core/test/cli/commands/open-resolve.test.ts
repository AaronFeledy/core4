import { describe, expect, test } from "bun:test";
import {
  type AppPlan,
  type EndpointPlan,
  ProviderId,
  type ServiceConnection,
  ServiceName,
  type StartedService,
} from "@lando/sdk/schema";
import { DateTime } from "effect";
import { isOpenableScheme, resolveOpenTargets } from "../../../src/cli/commands/open.ts";

const plan: Pick<AppPlan, "services"> = {
  services: Object.fromEntries(
    ["api", "web"].map((name) => [
      name,
      {
        name: ServiceName.make(name),
        type: "generic",
        provider: ProviderId.make("test"),
        primary: false,
        environment: {},
        mounts: [],
        storage: [],
        endpoints: [{ _tag: "internal", protocol: "http", port: 80 }],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata: { resolvedAt: DateTime.makeUnsafe(0), source: "test", runtime: 4 },
        extensions: {},
      },
    ]),
  ),
};
const connection = (host: string, protocol: "http" | "https" = "https") =>
  ({
    scope: "host",
    source: "route",
    binding: "assigned",
    state: "active",
    host,
    protocol,
    port: protocol === "http" ? 8080 : 8443,
    url: `${protocol}://${host}:${protocol === "http" ? 8080 : 8443}/v1`,
    pathPrefix: "/v1",
    alternateUrls: [],
    endpoint: { port: 80, transport: "tcp", names: [], primary: false },
  }) satisfies ServiceConnection;
const rows: readonly StartedService[] = [
  { name: "api", state: "running", connections: [connection("api.test", "http")] },
  {
    name: "web",
    state: "running",
    connections: [connection("web.test"), connection("web-alt.test", "http")],
  },
];
const withWebEndpoints = (endpoints: readonly EndpointPlan[]): Pick<AppPlan, "services"> => ({
  services: Object.fromEntries(
    Object.values(plan.services).map((service) => [
      service.name,
      service.name === "web" ? { ...service, endpoints } : service,
    ]),
  ),
});

describe("resolveOpenTargets", () => {
  test.each([{}, { service: "web" }])(
    "selects a marked primary listener when secondary observations arrive first: %j",
    (selection) => {
      const declared = withWebEndpoints([
        { _tag: "internal", protocol: "https", port: 8080 },
        { _tag: "internal", protocol: "http", port: 80, primary: true },
      ]);
      const observed: readonly StartedService[] = [
        {
          name: "web",
          state: "running",
          connections: [
            {
              ...connection("secondary.test"),
              endpoint: { port: 8080, transport: "tcp", names: [], primary: false },
            },
            connection("primary.test", "http"),
          ],
        },
      ];
      expect(resolveOpenTargets(declared, selection, observed).map((target) => target.url)).toEqual([
        "http://primary.test:8080/v1",
      ]);
    },
  );

  test.each([{}, { service: "web" }])("leaves two unmarked HTTP listeners unresolved: %j", (selection) => {
    const declared = withWebEndpoints([
      { _tag: "internal", protocol: "http", port: 80 },
      { _tag: "internal", protocol: "https", port: 8080 },
    ]);
    const observed: readonly StartedService[] = [
      {
        name: "web",
        state: "running",
        connections: [
          connection("first.test", "http"),
          {
            ...connection("second.test"),
            endpoint: { port: 8080, transport: "tcp", names: [], primary: false },
          },
        ],
      },
    ];
    expect(resolveOpenTargets(declared, selection, observed)).toEqual([]);
    expect(resolveOpenTargets(declared, { all: true }, observed)).toHaveLength(2);
    expect(
      resolveOpenTargets(declared, { route: "second.test" }, observed).map((target) => target.hostname),
    ).toEqual(["second.test"]);
  });
  test.each([
    [{}, ["api.test"]],
    [{ service: "web" }, ["web.test"]],
    [{ route: "web-alt.test", service: "api" }, ["web-alt.test"]],
    [{ all: true }, ["api.test", "web.test", "web-alt.test"]],
    [{ all: true, service: "web" }, ["web.test", "web-alt.test"]],
    [{ service: "missing" }, []],
    [{ route: "missing.test" }, []],
  ] as const)("preserves selection %j", (selection, hosts) => {
    const result = resolveOpenTargets(plan, selection, rows);
    expect(result.map((target) => target.hostname)).toEqual([...hosts]);
  });

  test("preserves observed ports and route prefixes without guessing", () => {
    const result = resolveOpenTargets(plan, { service: "web" }, rows);
    expect(result.map((target) => target.url)).toEqual(["https://web.test:8443/v1"]);
  });

  test("prefers https within the first service", () => {
    const observed = [
      {
        name: "api",
        state: "running" as const,
        connections: [connection("plain.test", "http"), connection("secure.test")],
      },
    ];
    expect(resolveOpenTargets(plan, {}, observed).map((target) => target.hostname)).toEqual(["secure.test"]);
  });

  test.each(["inactive", "unknown"] as const)("excludes %s assigned connections", (state) => {
    const observed = [
      { name: "web", state: "running" as const, connections: [{ ...connection("web.test"), state }] },
    ];
    expect(resolveOpenTargets(plan, { all: true }, observed)).toEqual([]);
  });

  test("excludes pending, wildcard, app-network and non-http connections", () => {
    const endpoint = { port: 80, transport: "tcp" as const, names: [], primary: false };
    const observed: readonly StartedService[] = [
      {
        name: "web",
        state: "running",
        connections: [
          {
            scope: "host",
            source: "route",
            binding: "pending",
            state: "unknown",
            host: "pending.test",
            protocol: "https",
            pathPrefix: "/v1",
            endpoint,
          },
          connection("*.wild.test"),
          {
            scope: "app",
            source: "listener",
            binding: "assigned",
            state: "active",
            host: "web",
            protocol: "http",
            port: 80,
            url: "http://web",
            alternateUrls: [],
            endpoint,
          },
          {
            scope: "host",
            source: "publication",
            binding: "assigned",
            state: "active",
            host: "localhost",
            protocol: "tcp",
            port: 8080,
            url: "tcp://localhost:8080",
            alternateUrls: [],
            endpoint,
          },
        ],
      },
    ];
    expect(resolveOpenTargets(plan, { all: true }, observed)).toEqual([]);
  });

  test("uses active direct publications when routes are not active", () => {
    const observed: readonly StartedService[] = [
      {
        name: "web",
        state: "running",
        connections: [
          { ...connection("web.test"), state: "unknown" },
          {
            scope: "host",
            source: "publication",
            binding: "assigned",
            state: "active",
            host: "localhost",
            protocol: "http",
            port: 49152,
            url: "http://localhost:49152",
            alternateUrls: [],
            endpoint: { port: 80, transport: "tcp", names: [], primary: false },
          },
        ],
      },
    ];
    expect(resolveOpenTargets(plan, {}, observed).map((target) => target.url)).toEqual([
      "http://localhost:49152",
    ]);
    expect(resolveOpenTargets(plan, { route: "web.test" }, observed)).toEqual([]);
  });

  test("prefers observed routes before publications on earlier services", () => {
    const observed: readonly StartedService[] = [
      {
        name: "api",
        state: "running",
        connections: [
          {
            scope: "host",
            source: "publication",
            binding: "assigned",
            state: "active",
            host: "localhost",
            protocol: "http",
            port: 8000,
            url: "http://localhost:8000",
            alternateUrls: [],
            endpoint: { port: 80, transport: "tcp", names: [], primary: false },
          },
        ],
      },
      rows[1] ?? { name: "web", state: "running", connections: [] },
    ];
    expect(resolveOpenTargets(plan, {}, observed).map((target) => target.hostname)).toEqual(["web.test"]);
  });

  test("collapses dual-scheme route observations without losing distinct prefixes", () => {
    const observed: readonly StartedService[] = [
      {
        name: "web",
        state: "running",
        connections: [
          connection("web.test", "http"),
          connection("web.test"),
          { ...connection("web.test"), pathPrefix: "/v2", url: "https://web.test:8443/v2" },
        ],
      },
    ];
    expect(resolveOpenTargets(plan, { all: true }, observed).map((target) => target.url)).toEqual([
      "https://web.test:8443/v1",
      "https://web.test:8443/v2",
    ]);
  });
});

test("only http and https schemes are openable", () => {
  expect(isOpenableScheme("https://a.test")).toBe(true);
  expect(isOpenableScheme("http://a.test")).toBe(true);
  expect(isOpenableScheme("ftp://a.test")).toBe(false);
  expect(isOpenableScheme("file:///etc/passwd")).toBe(false);
  expect(isOpenableScheme("invalid")).toBe(false);
});
