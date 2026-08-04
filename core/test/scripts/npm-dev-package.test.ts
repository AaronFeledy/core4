import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  deriveNpmAlphaVersion,
  deriveNpmBetaVersion,
  preparePackageJson,
  releasePackageNames,
  releasePackageWorkspaces,
} from "../../../scripts/prepare-npm-dev-packages";

const releaseScriptPath = resolve(import.meta.dirname, "../../../scripts/release.ts");
const repoRoot = resolve(import.meta.dirname, "../../..");

describe("npm dev package preparation", () => {
  test("includes @lando/paths so the published @lando/core/paths shim resolves", () => {
    expect(releasePackageWorkspaces).toContain("paths");
    expect(releasePackageNames).toContain("@lando/paths");
    expect(releasePackageWorkspaces.indexOf("paths")).toBeLessThan(releasePackageWorkspaces.indexOf("core"));
    expect(releasePackageNames.indexOf("@lando/paths")).toBeLessThan(
      releasePackageNames.indexOf("@lando/core"),
    );
  });

  test("includes @lando/state-store so published @lando/core can resolve its workspace dependency", () => {
    expect(releasePackageWorkspaces).toContain("state-store");
    expect(releasePackageNames).toContain("@lando/state-store");
    expect(releasePackageWorkspaces.indexOf("state-store")).toBeLessThan(
      releasePackageWorkspaces.indexOf("core"),
    );
    expect(releasePackageNames.indexOf("@lando/state-store")).toBeLessThan(
      releasePackageNames.indexOf("@lando/core"),
    );
  });

  test("publishes every runtime workspace dependency before its dependent release package", async () => {
    const workspaceByName = new Map(
      releasePackageNames.map((name, index) => [name, releasePackageWorkspaces[index] ?? ""]),
    );

    type WorkspaceEdge = {
      readonly packageName: string;
      readonly dependent: string;
      /** `dependencies` require publish-before-dependent order; peers only need inventory membership. */
      readonly kind: "dependency" | "peerDependency";
    };
    const edges: WorkspaceEdge[] = [];

    const collectWorkspaceEdges = (
      section: Readonly<Record<string, string>> | undefined,
      dependent: string,
      kind: WorkspaceEdge["kind"],
    ): void => {
      if (section === undefined) return;
      for (const [packageName, range] of Object.entries(section)) {
        if (typeof range !== "string" || !range.startsWith("workspace:")) continue;
        edges.push({ packageName, dependent, kind });
      }
    };

    for (const dependent of releasePackageNames) {
      const workspace = workspaceByName.get(dependent);
      if (workspace === undefined || workspace === "") continue;
      const packageJson = (await Bun.file(resolve(repoRoot, workspace, "package.json")).json()) as {
        readonly dependencies?: Readonly<Record<string, string>>;
        readonly peerDependencies?: Readonly<Record<string, string>>;
      };
      collectWorkspaceEdges(packageJson.dependencies, dependent, "dependency");
      collectWorkspaceEdges(packageJson.peerDependencies, dependent, "peerDependency");
    }

    expect(edges.length).toBeGreaterThan(0);

    for (const edge of edges) {
      // Membership: every workspace runtime edge (deps + peers) must be a release package.
      expect(releasePackageNames).toContain(edge.packageName);
      expect(workspaceByName.has(edge.packageName)).toBe(true);

      // Order: only hard `dependencies` must publish before the dependent.
      if (edge.kind !== "dependency") continue;

      expect(releasePackageNames.indexOf(edge.packageName)).toBeLessThan(
        releasePackageNames.indexOf(edge.dependent),
      );

      const dependencyWorkspace = workspaceByName.get(edge.packageName);
      const dependentWorkspace = workspaceByName.get(edge.dependent);
      expect(dependencyWorkspace).toBeDefined();
      expect(dependentWorkspace).toBeDefined();
      if (dependencyWorkspace === undefined || dependentWorkspace === undefined) continue;
      expect(releasePackageWorkspaces.indexOf(dependencyWorkspace)).toBeLessThan(
        releasePackageWorkspaces.indexOf(dependentWorkspace),
      );
    }
  });

  test("derives alpha package versions for workflow runs", () => {
    expect(deriveNpmAlphaVersion({ GITHUB_RUN_NUMBER: "123" })).toBe("4.0.0-alpha.123");
    expect(deriveNpmAlphaVersion({ LANDO_NPM_VERSION: "4.0.0-alpha.local" })).toBe("4.0.0-alpha.local");
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

  test("release orchestrator publishes alpha workspaces on the dev tag", async () => {
    const source = await Bun.file(releaseScriptPath).text();

    expect(source).toContain("prepareNpmAlphaPackages");
    expect(source).toContain("releasePackageNames.map");
    expect(source).toContain("npm publish --workspace ${packageName} --access public --tag dev --provenance");
    expect(source).toContain("npm view @lando/core dist-tags.dev --json");
  });
});
