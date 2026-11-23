import { describe, expect, test } from "bun:test";
import { ManagedFileError, ManagedFileTransactionError, StateStoreError } from "@lando/sdk/errors";
import { storeAwareTransactionError, transactionError } from "../src/transaction-error.ts";

const newer = () =>
  new StateStoreError({
    reason: "newer-version",
    operation: "get",
    path: "/data/transaction.json",
    storedVersion: 5,
    supportedVersion: 2,
    remediation:
      "A newer Lando wrote /data/transaction.json (envelope version 5; this Lando supports 2). Run the newer Lando that wrote it or upgrade Lando. Leave the file in place: replacing or deleting it would discard state the newer Lando depends on.",
  });

describe("storeAwareTransactionError", () => {
  test("preserves upgrade remediation for newer-version causes", () => {
    const cause = newer();
    const mapped = storeAwareTransactionError("journal", "inspect", cause);
    expect(mapped).toBeInstanceOf(ManagedFileTransactionError);
    expect(mapped.reason).toBe("journal");
    expect(mapped.path).toBe("/data/transaction.json");
    expect(mapped.remediation).toContain("newer Lando");
    expect(mapped.remediation).toMatch(/leave the file in place/i);
    expect(mapped.cause).toBe(cause);
    expect(mapped.remediation.length).toBeLessThanOrEqual(256);
    expect(mapped.remediation).not.toContain("Preserve the transaction journal");
  });

  test("falls back to domain remediation for other failures", () => {
    const mapped = storeAwareTransactionError("journal", "inspect", new Error("boom"));
    expect(mapped.remediation).toBe(transactionError("journal", "inspect").remediation);
  });

  test("passes lock remediation from the store", () => {
    const cause = new StateStoreError({
      reason: "lock",
      operation: "withLock",
      path: "/data/transaction.lock",
      remediation: "Retry after the other managed-file transaction finishes.",
    });
    const mapped = storeAwareTransactionError("lock", "prepare", cause);
    expect(mapped.remediation).toBe(cause.remediation);
    expect(mapped.path).toBe("/data/transaction.lock");
  });
});

describe("ManagedFileError ledger mapping shape", () => {
  test("newer-version cause keeps store remediation on ManagedFileError", () => {
    const cause = newer();
    const mapped = new ManagedFileError({
      reason: "io",
      operation: "status",
      cause,
      remediation: cause.remediation,
    });
    expect(mapped.cause).toBe(cause);
    expect(mapped.remediation).toContain("envelope version 5");
  });
});
