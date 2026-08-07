import { describe, expect, test } from "bun:test";

import { WORKSPACE_EDGE_TABLE } from "../../../scripts/boundary/rules/package-dag-policy.ts";

describe("workspace package DAG policy", () => {
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
