import { expect, test } from "bun:test";

import { STOCK_TAG_REFRESH_AFTER_MS } from "@lando/sdk/schema";
import { buildArtifactRefreshDoctorCheck } from "../../src/cli/commands/doctor-artifact-refresh.ts";

const provider = { id: "lando", displayName: "Lando", version: "0.0.0" };
const check = {
  ref: "php:8.4-apache-bookworm",
  platform: "linux-x64",
  runtimeId: "runtime",
  checkedAt: 0,
  afterMs: STOCK_TAG_REFRESH_AFTER_MS,
};

test("doctor stays quiet until a runtime has a recorded image check", () => {
  expect(
    buildArtifactRefreshDoctorCheck({
      checks: {},
      now: STOCK_TAG_REFRESH_AFTER_MS,
      runtimeId: "runtime",
      provider,
    }),
  ).toBeUndefined();
});

test("an overdue stock tag warns and names the next start, not a manual pull", () => {
  const report = buildArtifactRefreshDoctorCheck({
    checks: { one: check },
    now: STOCK_TAG_REFRESH_AFTER_MS,
    runtimeId: "runtime",
    provider,
  });
  expect(report?.status).toBe("warn");
  expect(report?.runtime.message).toContain("php:8.4-apache-bookworm");
  expect(report?.solutions[0]?.command).toBe("lando rebuild");
  expect(report?.solutions[0]?.description).toContain("next start");
});

test("a recent check passes", () => {
  const report = buildArtifactRefreshDoctorCheck({
    checks: { one: { ...check, checkedAt: STOCK_TAG_REFRESH_AFTER_MS - 1 } },
    now: STOCK_TAG_REFRESH_AFTER_MS,
    runtimeId: "runtime",
    provider,
  });
  expect(report?.status).toBe("pass");
  expect(report?.solutions).toEqual([]);
});
