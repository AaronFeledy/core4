import { describe, expect, test } from "bun:test";
import { StateStoreError } from "@lando/sdk/errors";
import { isNewerVersionStoreError, newerStateVersionError, storeErrorRemediation } from "@lando/state-store";

const newer = (overrides: Partial<ConstructorParameters<typeof StateStoreError>[0]> = {}) =>
  new StateStoreError({
    reason: "newer-version",
    operation: "get",
    path: "/tmp/state.json",
    storedVersion: 9,
    supportedVersion: 2,
    remediation:
      "A newer Lando wrote /tmp/state.json (envelope version 9; this Lando supports 2). Run the newer Lando that wrote it or upgrade Lando. Leave the file in place: replacing or deleting it would discard state the newer Lando depends on.",
    ...overrides,
  });

describe("storeErrorRemediation", () => {
  test("keeps the store upgrade text for newer-version", () => {
    const cause = newer();
    expect(storeErrorRemediation(cause, "fallback remove the corrupt file")).toBe(cause.remediation);
    expect(storeErrorRemediation(cause, "fallback")).not.toContain("corrupt");
    expect(storeErrorRemediation(cause, "fallback")).toContain("newer Lando");
  });

  test("uses the domain fallback for other store reasons and non-store causes", () => {
    const decode = new StateStoreError({
      reason: "decode",
      operation: "get",
      path: "/tmp/x",
      remediation: "The durable state file is corrupt; remove it or restore a backup.",
    });
    expect(storeErrorRemediation(decode, "domain fallback")).toBe("domain fallback");
    expect(storeErrorRemediation(new Error("io"), "domain fallback")).toBe("domain fallback");
    expect(storeErrorRemediation(undefined, "domain fallback")).toBe("domain fallback");
  });
});

describe("isNewerVersionStoreError", () => {
  test("narrows only newer-version StateStoreError", () => {
    expect(isNewerVersionStoreError(newer())).toBe(true);
    expect(
      isNewerVersionStoreError(
        new StateStoreError({
          reason: "version",
          operation: "get",
          remediation: "could not be migrated",
        }),
      ),
    ).toBe(false);
  });
});

describe("newerStateVersionError", () => {
  test("builds a tagged newer-version diagnosis for raw readers", () => {
    const error = newerStateVersionError({
      operation: "uninstall-sync-preflight",
      path: "/data/plan.json",
      storedVersion: 11,
      supportedVersion: 2,
    });
    expect(error).toMatchObject({
      _tag: "StateStoreError",
      reason: "newer-version",
      operation: "uninstall-sync-preflight",
      path: "/data/plan.json",
      storedVersion: 11,
      supportedVersion: 2,
    });
    expect(error.remediation).toContain("newer Lando");
    expect(error.remediation).toContain("Leave the file in place");
    expect(error.remediation.toLowerCase()).not.toContain("destroy");
    expect(error.remediation.toLowerCase()).not.toContain("move it aside");
  });
});
