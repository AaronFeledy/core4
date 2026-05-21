import { describe, expect, test } from "bun:test";

import { deriveNpmDevVersion, preparePackageJson } from "../../../scripts/prepare-npm-dev-packages";

describe("npm dev package preparation", () => {
  test("derives alpha package versions for workflow runs", () => {
    expect(deriveNpmDevVersion({ GITHUB_RUN_NUMBER: "123" })).toBe("4.0.0-alpha.123");
    expect(deriveNpmDevVersion({ LANDO_NPM_VERSION: "4.0.0-alpha.local" })).toBe("4.0.0-alpha.local");
  });

  test("marks packages publishable on npm's dev dist-tag", () => {
    expect(
      preparePackageJson(
        {
          name: "@lando/sdk",
          version: "0.0.0",
          private: true,
        },
        "4.0.0-alpha.7",
      ),
    ).toMatchObject({
      version: "4.0.0-alpha.7",
      private: false,
      publishConfig: { access: "public", tag: "dev", provenance: true },
    });
  });

  test("rewrites @lando/core's workspace SDK dependency to the same alpha version", () => {
    const prepared = preparePackageJson(
      {
        name: "@lando/core",
        version: "0.0.0",
        private: true,
        dependencies: {
          "@lando/sdk": "workspace:*",
          effect: "^3.21.2",
        },
      },
      "4.0.0-alpha.7",
    );

    expect(prepared.dependencies).toEqual({
      "@lando/sdk": "4.0.0-alpha.7",
      effect: "^3.21.2",
    });
  });
});
