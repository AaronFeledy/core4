import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { LANDO_FEATURE_ID, landoServiceFeature, landoServiceType } from "../src/services/lando.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const planService = async (ports: ReadonlyArray<string>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    services: { worker: { type: "lando", image: "alpine:3", ports } },
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
  test("preserves host publication fields and UDP protocol", async () => {
    const plan = await planService(["127.0.0.1:5353:53/udp"]);

    expect(plan.endpoints).toEqual([
      {
        _tag: "published",
        name: "worker",
        protocol: "udp",
        port: 53,
        publication: { bindAddress: "127.0.0.1", hostPort: 5353 },
      },
    ]);
  });

  test("rejects unsupported protocols with a tagged feature error", async () => {
    const result = planService(["8080:80/sctp"]);

    await expect(result).rejects.toHaveProperty("name", "(FiberFailure) ServiceFeatureError");
    await expect(result).rejects.toHaveProperty("message", expect.stringContaining("Allowed: tcp, udp"));
  });
});
