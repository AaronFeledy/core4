import { describe, expect, test } from "bun:test";

describe("release workflow", () => {
  test("smoke-tests the published core package with its workspace seams and bundled plugins", async () => {
    // Given
    const generator: unknown = await import(
      new URL("../../../scripts/build-release-workflow.ts", import.meta.url).href
    );
    if (
      typeof generator !== "object" ||
      generator === null ||
      !("renderReleaseWorkflow" in generator) ||
      typeof generator.renderReleaseWorkflow !== "function"
    ) {
      throw new TypeError("release workflow generator does not export renderReleaseWorkflow");
    }
    const workflow: unknown = generator.renderReleaseWorkflow();
    if (typeof workflow !== "string") throw new TypeError("renderReleaseWorkflow must return a string");
    const jobStart = workflow.indexOf("  npm-alpha-packages:");
    expect(jobStart).toBeGreaterThanOrEqual(0);
    const job = workflow.slice(jobStart);

    // When
    const publishPosition = job.indexOf("- name: Publish npm dev packages");
    const smokePosition = job.indexOf("- name: Smoke-test published npm packages");
    const smoke = job.slice(smokePosition);

    // Then
    expect(publishPosition).toBeGreaterThanOrEqual(0);
    expect(smokePosition).toBeGreaterThan(publishPosition);
    expect(smoke).toContain("LANDO_NPM_VERSION: 4.0.0-alpha.${{ github.run_number }}");
    expect(smoke).toContain('SMOKE_ROOT="$RUNNER_TEMP/lando-npm-smoke"');
    expect(smoke).toContain(
      'for package_spec in "@lando/sdk@$LANDO_NPM_VERSION" "@lando/paths@$LANDO_NPM_VERSION"',
    );
    expect(smoke).toContain('"@lando/core@$LANDO_NPM_VERSION"');
    expect(smoke).toContain('"@lando/provider-lando@$LANDO_NPM_VERSION"');
    expect(smoke).toContain('"@lando/template-mustache@$LANDO_NPM_VERSION"; do');
    expect(smoke).toContain('npm view "$package_spec" version');
    expect(smoke).toContain(
      'npm install --ignore-scripts --no-audit --no-fund "@lando/core@$LANDO_NPM_VERSION"',
    );
    expect(smoke).toContain('Bun.resolveSync("@lando/engine", process.env.SMOKE_ROOT)');
    expect(smoke).toContain('Bun.resolveSync("@lando/landofile", process.env.SMOKE_ROOT)');
    expect(smoke).toContain('await import("@lando/core/testing")');
    expect(smoke).toContain(
      'npm install --ignore-scripts --no-audit --no-fund "@lando/provider-lando@$LANDO_NPM_VERSION"',
    );
    expect(smoke).toContain('await import("@lando/core")');
    expect(smoke).toContain("makeLandoRuntime");
    expect(smoke).toContain("openLandoRuntime");
  });
});
