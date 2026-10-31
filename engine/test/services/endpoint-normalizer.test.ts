import { expect, test } from "bun:test";
import { type EndpointPlan, ServiceConfig, groupLogicalEndpoints } from "@lando/sdk/schema";
import { Schema } from "effect";
import { endpointValidationError, normalizeEndpoints } from "../../src/services/endpoint-normalizer.ts";

test("classifies matching publications without promoting unknown TCP listeners", () => {
  // Given
  const contributions: readonly EndpointPlan[] = [
    { _tag: "internal", port: 3000, protocol: "http", primary: true, name: "web" },
  ];
  const config = Schema.decodeUnknownSync(ServiceConfig)({
    ports: ["13001:3001", { target: 3000, published: 13000, name: "browser", app_protocol: "opaque" }],
    expose: [3000, 9000],
  });
  // When
  const endpoints = normalizeEndpoints(contributions, config);
  // Then
  expect(endpoints).toEqual([
    ...contributions,
    { _tag: "published", port: 3001, protocol: "tcp", publication: { hostPort: 13001 } },
    {
      _tag: "published",
      port: 3000,
      protocol: "http",
      primary: true,
      name: "browser",
      appProtocol: "opaque",
      publication: { hostPort: 13000 },
    },
    { _tag: "internal", port: 9000, protocol: "tcp" },
  ]);
  expect(groupLogicalEndpoints(endpoints).find((endpoint) => endpoint.port === 3000)?.names).toEqual([
    "browser",
    "web",
  ]);
});

test("preserves distinct bindings and aliases while deduplicating identical facets", () => {
  // Given
  const listener = { _tag: "internal", port: 8080, protocol: "http", primary: true, name: "web" } as const;
  const config = Schema.decodeUnknownSync(ServiceConfig)({
    ports: ["18080:8080", "28080:8080", "18080:8080", "18080:8080/udp"],
  });
  // When
  const endpoints = normalizeEndpoints([listener, listener], config);
  // Then
  expect(endpoints).toEqual([
    listener,
    {
      _tag: "published",
      port: 8080,
      protocol: "http",
      primary: true,
      name: "web",
      publication: { hostPort: 18080 },
    },
    {
      _tag: "published",
      port: 8080,
      protocol: "http",
      primary: true,
      name: "web",
      publication: { hostPort: 28080 },
    },
    { _tag: "published", port: 8080, protocol: "udp", publication: { hostPort: 18080 } },
  ]);
  expect(normalizeEndpoints([listener, listener], config)).toEqual(endpoints);
});

test.each([{ endpoints: [] }, { endpoints: [{ _tag: "internal", protocol: "tcp", port: 1234 }] }])(
  "keeps explicit endpoints authoritative over contributions, ports and expose: %j",
  ({ endpoints }) => {
    // Given
    const config = Schema.decodeUnknownSync(ServiceConfig)({
      endpoints,
      ports: ["18080:8080"],
      expose: [9000],
    });
    // When
    const normalized = normalizeEndpoints(
      [{ _tag: "internal", protocol: "http", port: 8080, primary: true }],
      config,
    );
    // Then
    expect(normalized).toEqual([...endpoints]);
  },
);

test("publications inherit sparse scan defaults from every matching facet", () => {
  // Given
  const contributions: readonly EndpointPlan[] = [
    { _tag: "internal", protocol: "http", port: 9000, scan: { path: "/minio/health/live" } },
    { _tag: "published", protocol: "http", port: 9000, publication: {}, scan: { okCodes: [204] } },
    { _tag: "internal", protocol: "http", port: 9001, scan: { path: "/" } },
  ];
  const config = Schema.decodeUnknownSync(ServiceConfig)({ ports: ["19000:9000", "19001:9001"] });
  // When
  const endpoints = normalizeEndpoints(contributions, config);
  // Then
  expect(endpoints.slice(3).map((endpoint) => endpoint.scan)).toEqual([
    { path: "/minio/health/live", okCodes: [204] },
    { path: "/" },
  ]);
});

test.each([{ endpoints: [] }, { endpoints: [{ _tag: "internal", protocol: "http", port: 9000 }] }])(
  "explicit endpoints replace discovery scan metadata: %j",
  ({ endpoints }) => {
    // Given
    const config = Schema.decodeUnknownSync(ServiceConfig)({ endpoints, ports: ["19000:9000"] });
    // When
    const result = normalizeEndpoints(
      [{ _tag: "internal", protocol: "http", port: 9000, scan: { path: "/health" } }],
      config,
    );
    // Then
    expect(result).toEqual([...endpoints]);
  },
);

test.each([
  { first: { path: "/health" }, second: { path: "/" }, conflict: true },
  { first: { okCodes: [200, 204] }, second: { okCodes: [204] }, conflict: true },
  { first: { okCodes: [200, 204] }, second: { okCodes: [204, 200, 204] }, conflict: false },
  { first: { path: "/health" }, second: { okCodes: [] }, conflict: false },
])("preserves logical scan invariants before and after normalization: %j", ({ first, second, conflict }) => {
  // Given
  const contributions: readonly EndpointPlan[] = [
    { _tag: "internal", protocol: "http", port: 9000, scan: first },
    { _tag: "published", protocol: "http", port: 9000, publication: {}, scan: second },
  ];
  // When
  const normalized = normalizeEndpoints(
    contributions,
    Schema.decodeUnknownSync(ServiceConfig)({ ports: ["19000:9000"] }),
  );
  const errors = [contributions, normalized].map((endpoints) =>
    endpointValidationError(endpoints, { appRoot: "/app", serviceName: "storage" }),
  );
  // Then
  expect(errors.map((error) => error !== undefined)).toEqual([conflict, conflict]);
  if (conflict) {
    expect(errors.map((error) => error?.issues?.length)).toEqual([1, 1]);
    for (const error of errors) expect(error?.issues?.[0]?.message).toContain("9000/tcp");
  }
});
