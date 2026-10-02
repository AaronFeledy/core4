import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, PortablePath, ServiceName } from "@lando/sdk/schema";

import { LANDO_FEATURE_ID, landoServiceFeature, landoServiceType } from "../src/services/lando.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const planService = async (config: unknown) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    services: { worker: config },
  });
  const service = landofile.services?.[ServiceName.make("worker")];
  if (service === undefined) throw new Error("worker service missing");
  return composeServicePlan({
    serviceType: landoServiceType,
    service,
    appRoot: "/srv/apps/myapp",
    metadata: { resolvedAt: "2026-07-23T08:00:00Z", source: "/srv/apps/myapp/.lando.yml", runtime: 4 },
    serviceName: "worker",
    featureOverrides: new Map([[LANDO_FEATURE_ID, landoServiceFeature]]),
  });
};

describe("lando endpoint intent", () => {
  test("preserves an internal HTTP endpoint when no ports are authored", async () => {
    // Given
    const endpoints = [{ _tag: "internal", protocol: "http", port: 80 }] as const;

    // When
    const plan = await planService({ type: "lando", image: "traefik/whoami", endpoints });

    // Then
    expect(plan.endpoints).toEqual(endpoints);
  });

  test("preserves host publication fields and UDP protocol", async () => {
    const plan = await planService({ type: "lando", image: "alpine:3", ports: ["127.0.0.1:5353:53/udp"] });

    expect(plan.endpoints).toEqual([
      {
        _tag: "published",
        protocol: "udp",
        port: 53,
        publication: { bindAddress: "127.0.0.1", hostPort: 5353 },
      },
    ]);
  });

  test("rejects unsupported protocols at Landofile decode", async () => {
    // Grammar moved into the service schema, so this now fails at decode, not feature-apply.
    const result = planService({ type: "lando", image: "alpine:3", ports: ["8080:80/sctp"] });

    await expect(result).rejects.toHaveProperty("name", "ParseError");
    await expect(result).rejects.toHaveProperty("message", expect.stringContaining("tcp"));
  });

  test.each([
    { endpoints: [{ _tag: "internal", protocol: "http", port: 80, name: "web" }] },
    { endpoints: [{ _tag: "published", protocol: "https", port: 443, publication: { hostPort: 8443 } }] },
    {
      endpoints: [{ _tag: "internal", protocol: "unix", socketPath: PortablePath.make("/run/worker.sock") }],
    },
    { endpoints: [] },
  ])(
    "uses authored endpoints instead of inferred ports when endpoints are declared: %j",
    async ({ endpoints }) => {
      // Given
      const config = { type: "lando", image: "traefik/whoami", ports: ["8080:80"], endpoints };

      // When
      const plan = await planService(config);

      // Then
      expect(plan.endpoints).toEqual(endpoints);
    },
  );
});
