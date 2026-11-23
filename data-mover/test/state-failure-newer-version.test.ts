import { describe, expect, test } from "bun:test";
import { DataTransferError, StateStoreError } from "@lando/sdk/errors";
import { stateFailure } from "../src/snapshot-paths.ts";

const newer = (path = "/tmp/sidecar.json") =>
  new StateStoreError({
    reason: "newer-version",
    operation: "get",
    path,
    storedVersion: 9,
    supportedVersion: 2,
    remediation:
      "A newer Lando wrote /tmp/sidecar.json (envelope version 9; this Lando supports 2). Run the newer Lando that wrote it or upgrade Lando. Leave the file in place: replacing or deleting it would discard state the newer Lando depends on.",
  });

describe("stateFailure newer-version mapping", () => {
  test("preserves upgrade remediation and tagged cause", () => {
    const cause = newer();
    const mapped = stateFailure("read-sidecar", cause);
    expect(mapped).toBeInstanceOf(DataTransferError);
    expect(mapped.cause).toBe(cause);
    expect(mapped.remediation).toBe(cause.remediation);
    expect(mapped.remediation).toContain("newer Lando");
    expect(mapped.remediation).toContain("Leave the file in place");
    expect(mapped.remediation).not.toContain("Inspect the Lando snapshot store");
  });

  test("keeps domain remediation for other store failures", () => {
    const cause = new StateStoreError({
      reason: "io",
      operation: "get",
      remediation: "disk full",
    });
    const mapped = stateFailure("read-sidecar", cause);
    expect(mapped.cause).toBe(cause);
    expect(mapped.remediation).toBe("Inspect the Lando snapshot store under the configured userDataRoot.");
  });
});
