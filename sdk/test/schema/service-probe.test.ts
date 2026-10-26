import { expect, test } from "bun:test";
import {
  PortNumber,
  ProviderId,
  ServiceName,
  ServicePlan,
  effectiveReadiness,
  landoServiceNetworkAliases,
  serviceListenerTarget,
} from "@lando/sdk/schema";
import { DateTime, Result, Schema } from "effect";

const service: ServicePlan = {
  name: ServiceName.make("db"),
  type: "mongodb",
  provider: ProviderId.make("test"),
  primary: false,
  environment: {},
  mounts: [],
  storage: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  extensions: {},
  endpoints: [
    { _tag: "internal", protocol: "tcp", port: PortNumber.make(27017), name: "database", primary: true },
  ],
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"), source: "probe", runtime: 4 },
};
const target = { port: PortNumber.make(27017), transport: "tcp" as const, names: [], primary: false };
const healthcheck = {
  kind: "command" as const,
  command: ["cheap"],
  intervalSeconds: 10,
  timeoutSeconds: 5,
  retries: 1,
  target,
};
const readiness = { ...healthcheck, command: ["strong"] };

test("selects strong startup readiness and falls back to ongoing health when absent", () => {
  expect(effectiveReadiness({ ...service, healthcheck, readiness })).toEqual(readiness);
  expect(effectiveReadiness({ ...service, healthcheck })).toEqual(healthcheck);
});

test("retains targeted probes through the public plan codec", () => {
  const planned = { ...service, healthcheck, readiness };
  const decoded = Schema.decodeUnknownSync(ServicePlan)(Schema.encodeSync(ServicePlan)(planned));
  expect(decoded.readiness).toEqual(readiness);
  expect(decoded.healthcheck).toEqual(healthcheck);
});

test.each([
  { networking: { perAppBridge: { name: "private", driver: "bridge" } }, host: "db", network: "private" },
  {
    networking: { perAppBridge: null, sharedNetworkMembership: { name: "shared", aliases: {} } },
    host: "db.demo.internal",
    network: "shared",
  },
])("resolves the declared listener with topology $host", ({ networking, host, network }) => {
  const result = serviceListenerTarget({ slug: "demo", networking }, service, target);
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result))
    expect(result.success).toEqual({ host, network, port: 27017, transport: "tcp" });
});

test("always realizes canonical shared aliases exactly once", () => {
  const aliases = landoServiceNetworkAliases(
    {
      slug: "demo",
      networking: {
        perAppBridge: null,
        sharedNetworkMembership: {
          name: "shared",
          aliases: { [ServiceName.make("db")]: ["extra", "db.demo.internal"] },
        },
      },
    },
    service,
  );
  expect(aliases).toEqual(["db.demo.internal", "extra"]);
});

test.each([
  {
    name: "missing port",
    endpoint: { ...target, port: PortNumber.make(1) },
    service,
    networking: { perAppBridge: { name: "private" } },
  },
  {
    name: "wrong transport",
    endpoint: { ...target, transport: "udp" as const },
    service,
    networking: { perAppBridge: { name: "private" } },
  },
  { name: "no network", endpoint: target, service, networking: { perAppBridge: null } },
  {
    name: "reserved loopback",
    endpoint: target,
    service: { ...service, name: ServiceName.make("localhost") },
    networking: { perAppBridge: { name: "private" } },
  },
  {
    name: "numeric loopback alias",
    endpoint: target,
    service: { ...service, name: ServiceName.make("2130706433") },
    networking: { perAppBridge: { name: "private" } },
  },
  {
    name: "loopback host alias",
    endpoint: target,
    service: { ...service, hostAliases: [{ hostname: "db", ip: "127.0.0.1" }] },
    networking: { perAppBridge: { name: "private" } },
  },
  {
    name: "Compose loopback host alias",
    endpoint: target,
    service: { ...service, extensions: { compose: { extra_hosts: { DB: "127.0.0.1" } } } },
    networking: { perAppBridge: { name: "private" } },
  },
  {
    name: "Compose override of the canonical shared alias",
    endpoint: target,
    service: { ...service, extensions: { compose: { extra_hosts: { "DB.DEMO.INTERNAL": "127.0.0.1" } } } },
    networking: { perAppBridge: null, sharedNetworkMembership: { name: "shared", aliases: {} } },
  },
])("refuses $name before realization", (input) => {
  const result = serviceListenerTarget(
    { slug: "demo", networking: input.networking },
    input.service,
    input.endpoint,
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure._tag).toBe("LandofileValidationError");
});

test("retains managed listener DNS beside an unrelated Compose host alias", () => {
  const result = serviceListenerTarget(
    { slug: "demo", networking: { perAppBridge: { name: "private" } } },
    { ...service, extensions: { compose: { extra_hosts: { cache: "127.0.0.1" } } } },
    target,
  );

  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) expect(result.success.host).toBe("db");
});
