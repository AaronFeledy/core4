import { expect, test } from "bun:test";

import { GlobalAppError, ProxySetupError } from "@lando/sdk/errors";

import { mapSetupError } from "../src/proxy-setup.ts";

test("runtime readiness failure keeps its actionable provider remediation", () => {
  // Given: a provider failure carries its own actionable remediation.
  const cause = new GlobalAppError({
    message: "Managed machine is unavailable.",
    operation: "ensureProviderReady",
    remediation: "Run `lando setup` and inspect the managed machine.",
  });

  // When: setup maps the provider failure.
  const mapped = mapSetupError(cause);
  // Then: its remediation and cause survive the setup boundary.
  expect(mapped).toBeInstanceOf(ProxySetupError);
  expect(mapped.remediation).toBe(cause.remediation ?? "");
  expect(mapped.cause).toBe(cause);
});

test("setup failure directs recovery to setup when no provider remediation is available", () => {
  // Given: a failure without a provider-specific remediation.
  const cause = new Error("Route-config directory is unavailable.");

  // When: setup maps the failure.
  const mapped = mapSetupError(cause);

  // Then: recovery names the command that can actually retry setup.
  expect(mapped).toBeInstanceOf(ProxySetupError);
  expect(mapped.remediation).toBe("Resolve the reported failure, then run `lando setup`.");
  expect(mapped.cause).toBe(cause);
});
