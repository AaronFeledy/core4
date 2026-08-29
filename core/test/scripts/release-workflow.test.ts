import { describe, expect, test } from "bun:test";

import { renderReleaseWorkflow } from "../../../scripts/build-release-workflow.ts";
import { CI_PLATFORMS, releaseBinaryFileName } from "../../../scripts/ci-platforms.ts";

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
    expect(workflow).not.toContain("prepare-npm-dev-packages.ts");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
  });

  test("keeps GitHub binary prerelease", async () => {
    // Given
    const workflow = renderReleaseWorkflow();

    // Then: unsigned six-target GitHub prerelease job and assets
    expect(workflow).toContain("dev-prerelease:");
    expect(workflow).not.toContain("dev-prerelease-linux-x64:");
    for (const platform of CI_PLATFORMS) {
      expect(workflow).toContain(`--name lando-${platform.id}`);
      expect(workflow).toContain(`dist/${releaseBinaryFileName(platform)}`);
      expect(workflow).toContain(`test -f dist/${releaseBinaryFileName(platform)}`);
    }
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("v4.0.0-dev.${{ github.run_number }}");
    expect(workflow).toContain("dist/SHA256SUMS");
    expect(workflow).not.toContain("sha256sum lando > SHA256SUMS");
    expect(workflow).not.toContain("if-no-files-found");
  });

  test("scope comment reflects GitHub-only releases", async () => {
    // Given
    const workflow = renderReleaseWorkflow();

    // Then: scope comment mentions six unsigned binaries as a GitHub prerelease
    expect(workflow).toContain("six unsigned binaries");
    expect(workflow).toContain("every CI platform as a v4.0.0-dev.N GitHub prerelease");
    expect(workflow).not.toContain("ci-built linux-x64 binary as a v4.0.0-dev.N GitHub prerelease.");
    expect(workflow).not.toContain("publishes npm");
    expect(workflow).not.toContain("npm dev-tag packages");
  });
});
