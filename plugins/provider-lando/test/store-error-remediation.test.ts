import { expect, test } from "bun:test";
import { ProviderUnavailableError, StateStoreError } from "@lando/sdk/errors";
import { isNewerVersionStoreError, storeErrorRemediation } from "@lando/state-store";
import { receiptFailure, stateFailure } from "../src/windows-sync-helper-receipt.ts";

const upgrade =
  "A newer Lando wrote /tmp/x (envelope version 9; this Lando supports 2). Run the newer Lando that wrote it or upgrade Lando. Leave the file in place: replacing or deleting it would discard state the newer Lando depends on.";

const newer = () =>
  new StateStoreError({
    reason: "newer-version",
    operation: "get",
    path: "/tmp/x",
    storedVersion: 9,
    supportedVersion: 2,
    remediation: upgrade,
  });

test("isNewerVersionStoreError detects only newer-version store failures", () => {
  expect(isNewerVersionStoreError(newer())).toBe(true);
  expect(
    isNewerVersionStoreError(
      new StateStoreError({
        reason: "io",
        operation: "get",
        remediation: "fix permissions.",
      }),
    ),
  ).toBe(false);
  expect(isNewerVersionStoreError(new Error("nope"))).toBe(false);
});

test("storeErrorRemediation keeps upgrade text for newer-version causes", () => {
  expect(storeErrorRemediation(newer(), "fallback")).toBe(upgrade);
  expect(storeErrorRemediation(new Error("x"), "fallback")).toBe("fallback");
});

test("receiptFailure and stateFailure preserve newer-version remediation and cause", () => {
  const cause = newer();
  const failed = receiptFailure("Unable to read or update the sync helper ownership receipt.", cause);
  expect(failed).toBeInstanceOf(ProviderUnavailableError);
  expect(failed.remediation).toBe(upgrade);
  expect(failed.cause).toBe(cause);

  const mapped = stateFailure(cause);
  expect(mapped.remediation).toBe(upgrade);
  expect(mapped.cause).toBe(cause);
});

test("stateFailure still unwraps nested ProviderUnavailableError causes", () => {
  const inner = new ProviderUnavailableError({
    providerId: "lando",
    operation: "syncHelper.receipt",
    message: "inner",
    remediation: "Inspect the named volume.",
  });
  const wrapped = new StateStoreError({
    reason: "io",
    operation: "mutate",
    remediation: "store io",
    cause: inner,
  });
  expect(stateFailure(wrapped)).toBe(inner);
});
