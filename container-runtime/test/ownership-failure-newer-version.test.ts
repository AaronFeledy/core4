import { describe, expect, test } from "bun:test";
import { ProviderUnavailableError, StateStoreError } from "@lando/sdk/errors";
import { ownershipFailure } from "../src/resource-ownership-inventory.ts";

describe("ownershipFailure newer-version mapping", () => {
  test("preserves upgrade remediation and cause", () => {
    const cause = new StateStoreError({
      reason: "newer-version",
      operation: "get",
      path: "/state/resource-ownership.json",
      storedVersion: 3,
      supportedVersion: 1,
      remediation:
        "A newer Lando wrote /state/resource-ownership.json (envelope version 3; this Lando supports 1). Run the newer Lando that wrote it or upgrade Lando. Leave the file in place: replacing or deleting it would discard state the newer Lando depends on.",
    });
    const mapped = ownershipFailure("podman", cause);
    expect(mapped).toBeInstanceOf(ProviderUnavailableError);
    expect(mapped.cause).toBe(cause);
    expect(mapped.remediation).toBe(cause.remediation);
    expect(mapped.remediation).toContain("Leave the file in place");
    expect(mapped.remediation).not.toContain("Repair the provider plugin state");
  });

  test("keeps domain remediation without a newer-version cause", () => {
    const mapped = ownershipFailure("docker");
    expect(mapped.remediation).toContain("Repair the provider plugin state");
  });
});
