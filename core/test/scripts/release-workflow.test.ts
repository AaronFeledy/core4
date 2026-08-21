import { describe, expect, test } from "bun:test";

import { renderReleaseWorkflow } from "../../../scripts/build-release-workflow.ts";

describe("release workflow", () => {
  test("does not publish to npm", async () => {
    // Given
    const workflow = renderReleaseWorkflow();

    // Then: no npm publish jobs exist
    expect(workflow).not.toContain("npm-alpha-packages:");
    expect(workflow).not.toContain("npm-alpha-smoke:");
    expect(workflow).not.toContain("npm publish");
    expect(workflow).not.toContain("registry-url");
    expect(workflow).not.toContain("id-token: write");
    expect(workflow).not.toContain("Publish npm dev packages");
    expect(workflow).not.toContain("Smoke-test published npm packages");
  });

  test("keeps GitHub binary prerelease", async () => {
    // Given
    const workflow = renderReleaseWorkflow();

    // Then: dev-prerelease-linux-x64 job exists
    expect(workflow).toContain("dev-prerelease-linux-x64:");
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("v4.0.0-dev.${{ github.run_number }}");
    expect(workflow).toContain("dist/lando");
    expect(workflow).toContain("dist/SHA256SUMS");
  });

  test("scope comment reflects GitHub-only releases", async () => {
    // Given
    const workflow = renderReleaseWorkflow();

    // Then: scope comment mentions only GitHub prerelease
    expect(workflow).toContain("ci-built linux-x64 binary as a v4.0.0-dev.N GitHub prerelease.");
    expect(workflow).not.toContain("publishes npm");
    expect(workflow).not.toContain("npm dev-tag packages");
  });
});
