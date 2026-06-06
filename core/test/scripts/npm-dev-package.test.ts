import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  deriveNpmBetaVersion,
  deriveNpmDevVersion,
  preparePackageJson,
} from "../../../scripts/prepare-npm-dev-packages";

const releaseScriptPath = resolve(import.meta.dirname, "../../../scripts/release.ts");

describe("npm dev package preparation", () => {
  test("derives alpha package versions for workflow runs", () => {
    expect(deriveNpmDevVersion({ GITHUB_RUN_NUMBER: "123" })).toBe("4.0.0-alpha.123");
    expect(deriveNpmDevVersion({ LANDO_NPM_VERSION: "4.0.0-alpha.local" })).toBe("4.0.0-alpha.local");
  });

  test("derives beta package versions for release workflow runs", () => {
    expect(deriveNpmBetaVersion({ GITHUB_RUN_NUMBER: "123" })).toBe("4.0.0-beta.123");
    expect(deriveNpmBetaVersion({ LANDO_NPM_VERSION: "4.0.0-beta.local" })).toBe("4.0.0-beta.local");
  });

  test("marks packages publishable on the requested npm dist-tag", () => {
    expect(
      preparePackageJson(
        {
          name: "@lando/sdk",
          version: "0.0.0",
          private: true,
        },
        "4.0.0-beta.7",
        "next",
      ),
    ).toMatchObject({
      version: "4.0.0-beta.7",
      private: false,
      publishConfig: { access: "public", tag: "next", provenance: true },
    });
  });

  test("rewrites workspace dependencies to the same release version", () => {
    const prepared = preparePackageJson(
      {
        name: "@lando/provider-podman",
        version: "0.0.0",
        private: true,
        dependencies: {
          "@lando/container-runtime": "workspace:*",
          "@lando/provider-lando": "workspace:*",
          "@lando/sdk": "workspace:*",
          effect: "^3.21.2",
        },
        peerDependencies: {
          "@lando/core": "workspace:*",
        },
      },
      "4.0.0-beta.7",
      "next",
    );

    expect(prepared.dependencies).toEqual({
      "@lando/container-runtime": "4.0.0-beta.7",
      "@lando/provider-lando": "4.0.0-beta.7",
      "@lando/sdk": "4.0.0-beta.7",
      effect: "^3.21.2",
    });
    expect(prepared.peerDependencies).toEqual({
      "@lando/core": "4.0.0-beta.7",
    });
  });

  test("release orchestrator publishes beta workspaces on next and retires dev tags", async () => {
    const source = await Bun.file(releaseScriptPath).text();

    expect(source).toContain("prepareNpmBetaPackages");
    expect(source).toContain(
      "npm publish --workspace ${packageName} --access public --tag next --provenance",
    );
    expect(source).toContain("npm view @lando/core dist-tags.next --json");
    expect(source).toContain("npm dist-tag rm ${packageName} dev 2>/dev/null || true");
  });
});
