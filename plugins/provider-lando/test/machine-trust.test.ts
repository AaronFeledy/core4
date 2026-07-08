import { describe, expect, test } from "bun:test";

import {
  buildManagedMachineInitArgs,
  buildManagedMachineTrustSyncArgs,
  resolveMachineTrustImport,
  windowsHyperVPrepRemediation,
} from "../src/machine-trust.ts";

describe("provider-lando managed machine trust import argv", () => {
  test("init argv imports native CA before the machine name (Lando-owned create)", () => {
    expect(buildManagedMachineInitArgs("lando")).toEqual(["machine", "init", "--import-native-ca", "lando"]);
  });

  test("set argv imports native CA for a managed machine (Lando-owned manage)", () => {
    expect(buildManagedMachineTrustSyncArgs("lando")).toEqual([
      "machine",
      "set",
      "--import-native-ca",
      "lando",
    ]);
  });

  test("import flag is a bare boolean, never a path-valued flag", () => {
    for (const args of [buildManagedMachineInitArgs("lando"), buildManagedMachineTrustSyncArgs("lando")]) {
      const flag = args.find((token) => token.startsWith("--import-native-ca"));
      expect(flag).toBe("--import-native-ca");
      // No `=value` form and no filesystem-path token anywhere in the argv.
      expect(args.some((token) => token.includes("--import-native-ca="))).toBe(false);
      expect(args.some((token) => /[/~\\]|%USERPROFILE%|%TEMP%|[A-Za-z]:\\/u.test(token))).toBe(false);
    }
  });
});

describe("provider-lando machine trust import decision", () => {
  test("a missing machine is created and owned by Lando, so native CA is imported", () => {
    expect(resolveMachineTrustImport({ status: "missing" })).toEqual({
      kind: "import",
      mode: "create",
    });
  });

  test("a missing machine imports even if a stale record claims user ownership", () => {
    expect(
      resolveMachineTrustImport({ status: "missing", recordedOwnership: { createdByLando: false } }),
    ).toEqual({ kind: "import", mode: "create" });
  });

  test("an existing Lando-owned machine is managed, so native CA is imported", () => {
    for (const status of ["stopped", "running"] as const) {
      expect(resolveMachineTrustImport({ status, recordedOwnership: { createdByLando: true } })).toEqual({
        kind: "import",
        mode: "manage",
      });
    }
  });

  test("an existing user-owned machine is never modified implicitly", () => {
    for (const status of ["stopped", "running"] as const) {
      // Recorded as user-owned.
      expect(resolveMachineTrustImport({ status, recordedOwnership: { createdByLando: false } })).toEqual({
        kind: "skip",
        reason: "user-owned",
      });
      // No ownership record at all: an existing machine Lando did not create.
      expect(resolveMachineTrustImport({ status })).toEqual({ kind: "skip", reason: "user-owned" });
    }
  });
});

describe("provider-lando Windows Hyper-V prep remediation", () => {
  const remediation = windowsHyperVPrepRemediation();

  test("recommends `podman system hyperv-prep`", () => {
    expect(remediation).toContain("podman system hyperv-prep");
  });

  test("explains administrator privileges are required for prep", () => {
    expect(/admin/i.test(remediation)).toBe(true);
  });

  test("states Lando never runs prep or elevates for the user", () => {
    expect(/never|does not|will not|won't/i.test(remediation)).toBe(true);
  });

  test("carries no local certificate paths or host-specific details", () => {
    // Advisory text only: command names, not host paths / home dirs / drive letters.
    expect(/\/home\/|\/Users\/|~\/|[A-Za-z]:\\|%USERPROFILE%|\.crt|\.pem/u.test(remediation)).toBe(false);
  });
});
