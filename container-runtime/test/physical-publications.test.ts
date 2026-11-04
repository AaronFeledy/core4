import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type EndpointPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";
import { createConfigFingerprint } from "../src/create-fingerprint.ts";
import {
  containerHostConfigFragment,
  containerPortBindings,
  fingerprintPlannedPublishPorts,
} from "../src/plan.ts";
import { renderCompose } from "../src/podman/compose.ts";
import {
  inspectHostPortForEndpoint,
  probeUnpinnedServicePublishPorts,
} from "../src/service-publish-ports.ts";

const metadata = { resolvedAt: DateTime.makeUnsafe(0), source: "physical-publications", runtime: 4 as const };
const publication = {
  _tag: "published",
  port: 8080,
  protocol: "http",
  publication: { hostPort: 18080 },
} as const;
const alias = {
  ...publication,
  name: "alias",
  primary: true,
  appProtocol: "opaque",
  publication: { bindAddress: "127.0.0.1", hostPort: 18080 },
} as const;
const service: ServicePlan = {
  name: ServiceName.make("web"),
  type: "lando",
  provider: ProviderId.make("podman"),
  primary: true,
  artifact: { kind: "ref", ref: "nginx:alpine" },
  environment: {},
  mounts: [],
  endpoints: [publication],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};
const plan: AppPlan = {
  id: AppId.make("physical-publications"),
  name: "physical-publications",
  slug: "physical-publications",
  root: AbsolutePath.make("/tmp/physical-publications"),
  provider: service.provider,
  services: { [service.name]: service },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

test("emits one API binding when aliases describe one physical publication", () => {
  // Given equivalent aliases with implicit and explicit default bind addresses.
  const desired = { ...service, endpoints: [publication, alias] };
  // When
  const config = containerHostConfigFragment(plan, desired);
  // Then
  expect(config).toHaveProperty("PortBindings", { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "18080" }] });
});

test("emits one Compose binding when aliases describe one physical publication", () => {
  // Given
  const desired = { ...service, endpoints: [publication, alias] };
  // When
  const compose = Bun.YAML.parse(
    renderCompose(
      { ...plan, services: { [service.name]: desired } },
      { providerId: "podman", remediation: "Retry.", env: {} },
    ),
  );
  // Then
  expect(compose).toHaveProperty("services.web.ports", ["127.0.0.1:18080:8080"]);
});

test("keeps physical fingerprints stable when facets or application metadata change", () => {
  // Given retained internal facets and aliases for the same TCP listener.
  const endpoints: readonly EndpointPlan[] = [
    alias,
    { _tag: "internal", port: 8080, protocol: "http", name: "internal" },
    publication,
  ];
  // When
  const actual = createConfigFingerprint(plan, { ...service, endpoints }, {});
  // Then
  expect(actual).toBe(createConfigFingerprint(plan, service, {}));
  expect(fingerprintPlannedPublishPorts([publication, alias])).toBe(
    fingerprintPlannedPublishPorts([publication]),
  );
});

test("preserves distinct transport, bind address and host port in physical bindings", () => {
  // Given
  const publications = [
    publication,
    { ...publication, protocol: "udp" as const },
    { ...publication, publication: { bindAddress: "::1", hostPort: 18080 } },
    { ...publication, publication: { hostPort: 28080 } },
  ];
  // When
  const bindings = containerPortBindings(publications);
  // Then
  expect(bindings["8080/tcp"]).toHaveLength(3);
  expect(bindings["8080/udp"]).toHaveLength(1);
});

test("allocates once when dynamic publication aliases share physical identity", async () => {
  // Given
  const dynamic = { ...publication, publication: {} };
  let probes = 0;
  // When
  const result = await Effect.runPromise(
    probeUnpinnedServicePublishPorts([dynamic, { ...dynamic, name: "alias" }], {
      probeBind: () => {
        probes += 1;
        return Effect.succeed({ kind: "success" });
      },
    }),
  );
  // Then
  expect(probes).toBe(1);
  expect(
    result.map((endpoint) => (endpoint._tag === "published" ? endpoint.publication.hostPort : undefined)),
  ).toEqual([30000, 30000]);
});

test.each(["NetworkSettings", "HostConfig"])(
  "reuses only the matching listener and bind address from %s",
  (source) => {
    // Given
    const ports = {
      "443/tcp": [{ HostIp: "127.0.0.1", HostPort: "8443" }],
      "8080/tcp": [
        { HostIp: "0.0.0.0", HostPort: "28080" },
        { HostIp: "127.0.0.1", HostPort: "18080" },
      ],
    };
    const inspected =
      source === "NetworkSettings"
        ? { NetworkSettings: { Ports: ports } }
        : { HostConfig: { PortBindings: ports } };
    // When
    const hostPort = inspectHostPortForEndpoint(inspected, { ...publication, publication: {} });
    // Then
    expect(hostPort).toBe(18080);
  },
);
