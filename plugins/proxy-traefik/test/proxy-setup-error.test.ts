import { expect, test } from "bun:test";

import { GlobalAppError, ProxySetupError } from "@lando/sdk/errors";

import { mapSetupError } from "../src/proxy-setup.ts";

test("runtime readiness failure keeps its actionable provider remediation", () => {
  const cause = new GlobalAppError({
    message: "Managed machine is unavailable.",
    operation: "ensureProviderReady",
    remediation: "Run `lando setup` and inspect the managed machine.",
  });

  const mapped = mapSetupError(cause);
  expect(mapped).toBeInstanceOf(ProxySetupError);
  expect(mapped.remediation).toBe(cause.remediation ?? "");
  expect(mapped.cause).toBe(cause);
});
