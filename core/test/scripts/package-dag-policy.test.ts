import { describe, expect, test } from "bun:test";

import {
  WORKSPACE_EDGE_TABLE,
  isWorkspaceRuntimeTargetAllowed,
} from "../../../scripts/boundary/rules/package-dag-policy.ts";

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

  test("allows only approved engine composers to depend on engine", () => {
    // Given
    const engineComposers = ["@lando/core", "@lando/renderer"];
    const policies = Object.entries(WORKSPACE_EDGE_TABLE);

    // When
    const nonComposerPolicies = policies.filter(([packageName]) => !engineComposers.includes(packageName));

    // Then
    expect(WORKSPACE_EDGE_TABLE["@lando/core"]?.dependencies).toBe("workspace");
    for (const [, policy] of nonComposerPolicies) {
      expect(policy.dependencies).not.toContain("@lando/engine");
      expect(policy.devDependencies).not.toContain("@lando/engine");
    }
  });

  test("limits non-core source imports of core to the private docs build host", () => {
    // Given
    const policies = Object.entries(WORKSPACE_EDGE_TABLE);

    // When
    const runtimeCoreConsumers = policies
      .filter(
        ([packageName, policy]) =>
          packageName !== "@lando/core" &&
          policy.dependencies !== "workspace" &&
          policy.dependencies.includes("@lando/core"),
      )
      .map(([packageName]) => packageName);

    // Then: docs may import core at build time, but must not declare a runtime dependency
    expect(runtimeCoreConsumers).toEqual([]);
    expect(WORKSPACE_EDGE_TABLE["@lando/docs"]).toEqual({
      dependencies: [],
      devDependencies: ["@lando/core", "@lando/sdk"],
      sourceTargets: ["@lando/core", "@lando/sdk"],
    });
    expect(isWorkspaceRuntimeTargetAllowed("@lando/docs", "@lando/core")).toBe(true);
    expect(isWorkspaceRuntimeTargetAllowed("@lando/docs", "@lando/sdk")).toBe(true);
  });

  test("isWorkspaceRuntimeTargetAllowed matches table-driven source allowance", () => {
    // Given / When / Then: engine may import sdk but not core; docs may not import engine; unknown packages deny.
    expect(isWorkspaceRuntimeTargetAllowed("@lando/engine", "@lando/sdk")).toBe(true);
    expect(isWorkspaceRuntimeTargetAllowed("@lando/engine", "@lando/core")).toBe(false);
    expect(isWorkspaceRuntimeTargetAllowed("@lando/docs", "@lando/engine")).toBe(false);
    expect(isWorkspaceRuntimeTargetAllowed("@lando/unknown", "@lando/sdk")).toBe(false);
  });
});
