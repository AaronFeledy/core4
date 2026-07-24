import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { COMPOSE_FEATURE_ID, composeServiceFeature, composeServiceType } from "../src/services/compose.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-07-23T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const planService = async (serviceConfig: unknown) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({ services: { worker: serviceConfig } });
  const service = landofile.services?.[ServiceName.make("worker")];
  if (service === undefined) throw new Error("worker service missing");
  return composeServicePlan({
    serviceType: composeServiceType,
    service,
    appRoot: "/srv/apps/myapp",
    metadata,
    serviceName: "worker",
    featureOverrides: new Map([[COMPOSE_FEATURE_ID, composeServiceFeature]]),
  });
};

describe("compose endpoint intent", () => {
  test("translates a host-shaped port into a published endpoint", async () => {
    const plan = await planService({ type: "compose", image: "alpine:3", ports: ["127.0.0.1:38080:80"] });

    expect(plan.endpoints).toEqual([
      {
        _tag: "published",
        name: "worker",
        protocol: "tcp",
        port: 80,
        publication: { bindAddress: "127.0.0.1", hostPort: 38080 },
      },
    ]);
  });

  test("preserves authored internal endpoints instead of compose ports", async () => {
    const plan = await planService({
      type: "compose",
      image: "alpine:3",
      ports: ["38080:80"],
      endpoints: [{ _tag: "internal", name: "web", protocol: "http", port: 80 }],
    });

    expect(plan.endpoints).toEqual([{ _tag: "internal", name: "web", protocol: "http", port: 80 }]);
  });

  test("leaves the host port unset for a container-only port", async () => {
    const plan = await planService({ type: "compose", image: "alpine:3", ports: ["8080"] });

    expect(plan.endpoints).toEqual([
      { _tag: "published", name: "worker", protocol: "tcp", port: 8080, publication: {} },
    ]);
  });

  test("parses an IPv4 dynamic host-port publication", async () => {
    const plan = await planService({ type: "compose", image: "alpine:3", ports: ["127.0.0.1::80"] });

    expect(plan.endpoints).toEqual([
      {
        _tag: "published",
        name: "worker",
        protocol: "tcp",
        port: 80,
        publication: { bindAddress: "127.0.0.1" },
      },
    ]);
  });

  test("parses a bracketed IPv6 dynamic host-port publication", async () => {
    const plan = await planService({ type: "compose", image: "alpine:3", ports: ["[::1]::80"] });

    expect(plan.endpoints).toEqual([
      {
        _tag: "published",
        name: "worker",
        protocol: "tcp",
        port: 80,
        publication: { bindAddress: "::1" },
      },
    ]);
  });
});
