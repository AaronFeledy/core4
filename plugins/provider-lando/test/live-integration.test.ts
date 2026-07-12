import { expect, test } from "bun:test";

import { liveIntegrationEligibility, liveIntegrationTestName } from "./live-integration.ts";

test("records an unavailable live prerequisite as a structured environment skip", () => {
  const eligibility = liveIntegrationEligibility([
    { available: true, reason: "available" },
    { available: false, reason: "LANDO_TEST_EXAMPLE is not enabled" },
  ]);

  expect(eligibility).toEqual({
    available: false,
    skip: { kind: "environment", reason: "LANDO_TEST_EXAMPLE is not enabled" },
  });
  expect(liveIntegrationTestName("runs live example", eligibility)).toBe(
    "runs live example [skip:environment:LANDO_TEST_EXAMPLE is not enabled]",
  );
});
