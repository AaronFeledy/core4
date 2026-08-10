import { describe, expect, test } from "bun:test";

import { WORKSPACE_EDGE_TABLE } from "../../../scripts/boundary/rules/package-dag-policy.ts";

describe("workspace package DAG policy", () => {
  test("allows the managed-file package to depend only on its primitive inputs", () => {
    // Given / When
    const managedFilePolicy = WORKSPACE_EDGE_TABLE["@lando/managed-file"];
    const enginePolicy = WORKSPACE_EDGE_TABLE["@lando/engine"];

    // Then
    expect(managedFilePolicy).toEqual({
      dependencies: ["@lando/sdk", "@lando/paths", "@lando/state-store", "@lando/redaction"],
      devDependencies: [],
    });
    expect(enginePolicy?.dependencies).not.toContain("@lando/managed-file");
    expect(enginePolicy?.devDependencies).not.toContain("@lando/managed-file");
  });

  test("allows only core to depend on engine", () => {
    // Given
    const policies = Object.entries(WORKSPACE_EDGE_TABLE);

    // When
    const nonCorePolicies = policies.filter(([packageName]) => packageName !== "@lando/core");

    // Then
    expect(WORKSPACE_EDGE_TABLE["@lando/core"]?.dependencies).toBe("workspace");
    for (const [, policy] of nonCorePolicies) {
      expect(policy.dependencies).not.toContain("@lando/engine");
      expect(policy.devDependencies).not.toContain("@lando/engine");
    }
  });

  test("prevents non-core runtime policies from depending on core", () => {
    // Given
    const policies = Object.entries(WORKSPACE_EDGE_TABLE);

    // When
    const nonCoreRuntimeTargets = policies
      .filter(([packageName]) => packageName !== "@lando/core")
      .map(([, policy]) => policy.dependencies);

    // Then
    for (const targets of nonCoreRuntimeTargets) {
      expect(targets).not.toBe("workspace");
      expect(targets).not.toContain("@lando/core");
    }
  });
});
