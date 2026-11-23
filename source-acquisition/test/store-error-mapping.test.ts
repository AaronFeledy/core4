import { describe, expect, test } from "bun:test";
import { StateStoreError } from "@lando/sdk/errors";
import { acquisitionError } from "../src/errors.ts";

describe("acquisitionError StateStoreError mapping", () => {
  test("preserves newer-version upgrade remediation", () => {
    const cause = new StateStoreError({
      reason: "newer-version",
      operation: "get",
      path: "/cache/sources/index.json",
      storedVersion: 4,
      supportedVersion: 1,
      remediation:
        "A newer Lando wrote /cache/sources/index.json (envelope version 4; this Lando supports 1). Run the newer Lando that wrote it or upgrade Lando. Leave the file in place: replacing or deleting it would discard state the newer Lando depends on.",
    });
    const mapped = acquisitionError("cache", "source store", cause);
    expect(mapped.kind).toBe("cache");
    expect(mapped.remediation).toBe(cause.remediation);
    expect(mapped.remediation).toContain("Leave the file in place");
    expect(mapped.remediation).not.toContain("Check the source coordinates");
  });

  test("preserves other store remediations", () => {
    const cause = new StateStoreError({
      reason: "io",
      operation: "set",
      remediation: "Fix permissions on the source cache.",
    });
    const mapped = acquisitionError("cache", "npm-pkg", cause);
    expect(mapped.remediation).toBe(cause.remediation);
  });
});
