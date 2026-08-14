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

  test("limits non-core source imports of core to the private docs build host", () => {
    // Given
    const policies = Object.entries(WORKSPACE_EDGE_TABLE);

    // When
    const nonCoreSourceConsumers = policies
      .filter(
        ([packageName, policy]) =>
          packageName !== "@lando/core" &&
          policy.dependencies !== "workspace" &&
          policy.dependencies.includes("@lando/core"),
      )
      .map(([packageName]) => packageName);

    // Then
    expect(nonCoreSourceConsumers).toEqual(["@lando/docs"]);
    expect(WORKSPACE_EDGE_TABLE["@lando/docs"]).toEqual({
      dependencies: ["@lando/core", "@lando/sdk"],
      devDependencies: ["@lando/core", "@lando/sdk"],
    });
  });
});
