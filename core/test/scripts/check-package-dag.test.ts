import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { type PackageDagFixture, createPackageDagFixture } from "./package-dag-fixture.ts";

let fixture: PackageDagFixture;

beforeEach(async () => {
  fixture = await createPackageDagFixture();
});

afterEach(async () => {
  await fixture.dispose();
});

describe("check-package-dag manifest policy", () => {
  test("allows the declared runtime and dev/test workspace graph", async () => {
    // Given: the complete fixture graph written by beforeEach

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "Package DAG violations: 0\n", stderr: "" });
  });

  test("loads every member from root package.json", async () => {
    // Given
    await Promise.all([
      fixture.writeRoot(["core", "sdk", "container-runtime", "paths", "state-store", "plugins/*", "extra"]),
      fixture.writePackage("extra", "@lando/extra"),
    ]);

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result.stdout).toContain("[PackageDagPackageDeclarationMissing]");
    expect(result.stdout).toContain("@lando/extra");
    expect(result.stdout).toContain("Remediation:");
  });

  test("rejects an undeclared workspace edge with tagged remediation", async () => {
    // Given
    await fixture.writePackage("plugins/provider-lando", "@lando/provider-lando", {
      dependencies: { "@lando/provider-podman": "workspace:*" },
      devDependencies: { "@lando/core": "workspace:*" },
    });

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result.stdout).toContain("[PackageDagUndeclaredEdge]");
    expect(result.stdout).toContain("@lando/provider-lando dependencies -> @lando/provider-podman");
    expect(result.stdout).toContain("Remediation:");
  });

  test("rejects a plugin runtime edge to core with tagged remediation", async () => {
    // Given
    await fixture.writePackage("plugins/provider-lando", "@lando/provider-lando", {
      dependencies: { "@lando/core": "workspace:*" },
      devDependencies: { "@lando/core": "workspace:*" },
    });

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result.stdout).toContain("[PackageDagForbiddenRuntimeEdge]");
    expect(result.stdout).toContain("@lando/provider-lando dependencies -> @lando/core");
    expect(result.stdout).toContain("Remediation:");
  });

  test("rejects a seam runtime edge to core with tagged remediation", async () => {
    // Given
    await Promise.all([
      fixture.writeRoot([
        "core",
        "sdk",
        "container-runtime",
        "paths",
        "state-store",
        "landofile",
        "plugins/*",
      ]),
      fixture.writePackage("landofile", "@lando/landofile", {
        dependencies: { "@lando/core": "workspace:*" },
      }),
    ]);

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result.stdout).toContain("[PackageDagForbiddenRuntimeEdge]");
    expect(result.stdout).toContain("@lando/landofile dependencies -> @lando/core");
    expect(result.stdout).toContain("Remediation:");
  });

  test("default mode exits unsuccessfully with tagged remediation", async () => {
    // Given
    await fixture.writePackage("plugins/provider-lando", "@lando/provider-lando", {
      dependencies: { "@lando/core": "workspace:*" },
    });

    // When
    const result = await fixture.runGate([]);

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[PackageDagForbiddenRuntimeEdge]");
    expect(result.stderr).toContain("Remediation:");
  });
});
