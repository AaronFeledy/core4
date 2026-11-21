import { describe, expect, test } from "bun:test";
import { LandofileShape, PortablePath, ServiceName } from "@lando/sdk/schema";
import { Schema } from "effect";

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
    const wire = [{ kind: "internal", protocol: "http", port: 80 }] as const;
    const expected = [{ kind: "internal", protocol: "http", port: 80 }] as const;

    // When
    const plan = await planService({ type: "lando", image: "traefik/whoami", endpoints: wire });

    // Then
    expect(plan.endpoints).toEqual(expected);
  });

  test("preserves host publication fields and UDP protocol", async () => {
    const plan = await planService({ type: "lando", image: "alpine:3", ports: ["127.0.0.1:5353:53/udp"] });

    expect(plan.endpoints).toEqual([
      {
        kind: "published",
        protocol: "udp",
        port: 53,
        publication: { bindAddress: "127.0.0.1", hostPort: 5353 },
      },
    ]);
  });

  test("rejects unsupported protocols at Landofile decode", async () => {
    // Grammar moved into the service schema, so this now fails at decode, not feature-apply.
    const result = planService({ type: "lando", image: "alpine:3", ports: ["8080:80/sctp"] });

    await expect(result).rejects.toHaveProperty("name", "SchemaError");
    await expect(result).rejects.toHaveProperty("message", expect.stringContaining("tcp"));
  });

  test.each([
    {
      wire: [{ kind: "internal", protocol: "http", port: 80, name: "web" }],
      expected: [{ kind: "internal", protocol: "http", port: 80, name: "web" }],
    },
    {
      wire: [{ kind: "published", protocol: "https", port: 443, publication: { hostPort: 8443 } }],
      expected: [{ kind: "published", protocol: "https", port: 443, publication: { hostPort: 8443 } }],
    },
    {
      wire: [{ kind: "internal", protocol: "unix", socketPath: PortablePath.make("/run/worker.sock") }],
      expected: [{ kind: "internal", protocol: "unix", socketPath: PortablePath.make("/run/worker.sock") }],
    },
    { wire: [], expected: [] },
  ])(
    "uses authored endpoints instead of inferred ports when endpoints are declared: $wire",
    async ({ wire, expected }) => {
      // Given
      const config = { type: "lando", image: "traefik/whoami", ports: ["8080:80"], endpoints: wire };

      // When
      const plan = await planService(config);

      // Then
      expect(plan.endpoints).toEqual(expected);
    },
  );
});
