import { expect, test } from "bun:test";

import { AppId, BindAddress, type EndpointPlan, ProviderId, ServiceName } from "@lando/sdk/schema";

import {
  publishedEndpointUrl,
  publishedEndpointUrls,
  startedServiceRow,
} from "../../src/operations/authority-url.ts";

test("uses planned endpoints and status when inspect omits endpoints and state", () => {
  // Given
  const service = {
    name: ServiceName.make("web"),
    endpoints: [
      { _tag: "internal", protocol: "http", port: 8080 },
      { _tag: "published", protocol: "http", port: 8080, publication: {} },
      { _tag: "published", protocol: "https", port: 8443, publication: { hostPort: 38443 } },
    ] satisfies ReadonlyArray<EndpointPlan>,
  };
  // When
  const row = startedServiceRow(service, {
    app: AppId.make("app"),
    service: service.name,
    providerId: ProviderId.make("test"),
    status: "running",
  });
  // Then
  expect(row).toEqual({ name: "web", state: "running", endpoints: ["https://localhost:38443"] });
  expect(Object.keys(row)).toEqual(["name", "state", "endpoints"]);
});

test("prefers observed state and materialized endpoints when inspect supplies them", () => {
  // Given
  const service = { name: ServiceName.make("web"), endpoints: [] };
  // When
  const row = startedServiceRow(service, {
    app: AppId.make("app"),
    service: service.name,
    providerId: ProviderId.make("test"),
    status: "created",
    state: "running",
    endpoints: [
      {
        _tag: "published",
        protocol: "http",
        port: 8080,
        publication: { hostPort: 1234 },
        materialization: { bindAddress: BindAddress.make("::1"), hostPort: 49152 },
      },
    ],
  });
  // Then
  expect(row).toEqual({ name: "web", state: "running", endpoints: ["http://[::1]:49152"] });
});

test("renders only explicitly published endpoint URLs", () => {
  const urls = publishedEndpointUrls([
    { _tag: "internal", protocol: "http", port: 8080 },
    {
      _tag: "published",
      protocol: "https",
      port: 8443,
      publication: { bindAddress: BindAddress.make("127.0.0.1"), hostPort: 38443 },
    },
  ]);

  expect(urls).toEqual(["https://localhost:38443"]);
});

test("uses provider materialization for an assigned host port", () => {
  const url = publishedEndpointUrl({
    _tag: "published",
    protocol: "http",
    port: 8080,
    publication: {},
    materialization: { bindAddress: BindAddress.make("127.0.0.1"), hostPort: 49152 },
  });

  expect(url).toBe("http://localhost:49152");
});

test("brackets IPv6 bind addresses in openable URLs", () => {
  const url = publishedEndpointUrl({
    _tag: "published",
    protocol: "http",
    port: 8080,
    publication: { bindAddress: BindAddress.make("::1"), hostPort: 49152 },
  });

  expect(url).toBe("http://[::1]:49152");
});
