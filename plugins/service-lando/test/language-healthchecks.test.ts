import { expect, test } from "bun:test";
import { go122ServiceType } from "../src/services/go.ts";
import { nodeLtsServiceType } from "../src/services/node.ts";
import { python312ServiceType } from "../src/services/python.ts";
import { ruby33ServiceType } from "../src/services/ruby.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const runtimes = [nodeLtsServiceType, python312ServiceType, ruby33ServiceType, go122ServiceType];
test.each(runtimes)(
  "$id does not infer a server healthcheck from an authored worker command",
  async (serviceType) => {
    const plan = await composeServicePlan({
      serviceType,
      service: { type: serviceType.id, command: ["worker", "watch"] },
      appRoot: "/srv/language-checks",
      metadata: { resolvedAt: "2026-10-14T00:00:00Z", source: "language-healthchecks", runtime: 4 },
    });
    expect(plan.healthcheck).toBeUndefined();
    expect(plan.endpoints.length).toBeGreaterThan(0);
  },
);

test.each(runtimes)("$id preserves an explicitly authored readiness check", async (serviceType) => {
  const healthcheck = {
    kind: "command" as const,
    command: ["true"],
    intervalSeconds: 2,
    timeoutSeconds: 3,
    retries: 4,
    startPeriodSeconds: 7,
  };
  const plan = await composeServicePlan({
    serviceType,
    service: { type: serviceType.id, command: ["worker", "watch"], healthcheck },
    appRoot: "/srv/language-checks",
    metadata: { resolvedAt: "2026-10-14T00:00:00Z", source: "language-healthchecks", runtime: 4 },
  });
  expect(plan.healthcheck).toEqual(healthcheck);
});
