import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { COMPOSE_FEATURE_ID, composeServiceFeature, composeServiceType } from "../src/services/compose.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const planPorts = (ports: ReadonlyArray<string>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    services: { worker: { type: "compose", image: "alpine:3", ports } },
  });
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

describe("compose short-form ports", () => {
  test("authored endpoints replace compose-inferred ports", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      services: {
        worker: {
          type: "compose",
          image: "traefik:v3.3",
          ports: ["127.0.0.1:38080:80", "127.0.0.1:38443:443"],
          endpoints: [
            { name: "web", protocol: "http", port: 80, bind: "127.0.0.1", publishedPort: 38080 },
            {
              name: "websecure",
              protocol: "https",
              port: 443,
              bind: "127.0.0.1",
              publishedPort: 38443,
            },
          ],
        },
      },
    });
    const service = landofile.services?.[ServiceName.make("worker")];
    if (service === undefined) throw new Error("worker service missing");

    // When
    const plan = await composeServicePlan({
      serviceType: composeServiceType,
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
      serviceName: "worker",
      featureOverrides: new Map([[COMPOSE_FEATURE_ID, composeServiceFeature]]),
    });

    // Then
    expect(plan.endpoints).toEqual(service.endpoints);
    expect(plan.endpoints.filter((endpoint) => endpoint.protocol === "tcp")).toEqual([]);
  });

  test("keeps a bare port as a target-only endpoint", async () => {
    const plan = await planPorts(["80"]);

    expect(plan.endpoints).toEqual([{ port: 80, protocol: "tcp", name: "worker" }]);
  });

  test("keeps published and target ports as separate endpoint fields", async () => {
    const plan = await planPorts(["38080:80"]);

    expect(plan.endpoints).toEqual([{ port: 80, publishedPort: 38080, protocol: "tcp", name: "worker" }]);
  });

  test("keeps bind, published, and target values when parsing from the right", async () => {
    const plan = await planPorts(["127.0.0.1:38080:80", "127.0.0.1:38443:443"]);

    expect(plan.endpoints).toEqual([
      { port: 80, bind: "127.0.0.1", publishedPort: 38080, protocol: "tcp", name: "worker" },
      { port: 443, bind: "127.0.0.1", publishedPort: 38443, protocol: "tcp", name: "worker" },
    ]);
  });

  test("preserves UDP suffixes on target-only and host-bound endpoints", async () => {
    const plan = await planPorts(["53/udp", "127.0.0.1:5353:53/udp"]);

    expect(plan.endpoints).toEqual([
      { port: 53, protocol: "udp", name: "worker" },
      { port: 53, bind: "127.0.0.1", publishedPort: 5353, protocol: "udp", name: "worker" },
    ]);
  });

  test.each(["not-a-port", "0", "65536", "not-a-port:80"])(
    "rejects malformed port form %s at the port-number boundary",
    async (entry) => {
      await expect(planPorts([entry])).rejects.toBeInstanceOf(Error);
    },
  );

  test.each(["80/sctp", "80/", "80/tcp/extra", ":38080:80", "1e2:80"])(
    "rejects adversarial short-form port %s",
    async (entry) => {
      await expect(planPorts([entry])).rejects.toBeInstanceOf(Error);
    },
  );
});
