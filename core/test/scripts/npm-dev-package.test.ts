import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  deriveNpmDevVersion,
  deriveNpmNextVersion,
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

  test("includes @lando/managed-file before its engine and core dependents", () => {
    expect(releasePackageWorkspaces).toContain("managed-file");
    expect(releasePackageNames).toContain("@lando/managed-file");
    expect(releasePackageWorkspaces.indexOf("managed-file")).toBeLessThan(
      releasePackageWorkspaces.indexOf("engine"),
    );
    expect(releasePackageNames.indexOf("@lando/managed-file")).toBeLessThan(
      releasePackageNames.indexOf("@lando/engine"),
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
      expect(releasePackageNames).toContain(edge.packageName);
      expect(workspaceByName.has(edge.packageName)).toBe(true);

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

  test("derives dev package versions for workflow runs", () => {
    expect(deriveNpmDevVersion({ GITHUB_RUN_NUMBER: "123" })).toBe("4.0.0-dev.123");
    expect(deriveNpmDevVersion({ LANDO_NPM_VERSION: "4.0.0-dev.local" })).toBe("4.0.0-dev.local");
  });

  test("derives next package versions for release workflow runs", () => {
    expect(deriveNpmNextVersion({ GITHUB_RUN_NUMBER: "123" })).toBe("4.0.0-next.123");
    expect(deriveNpmNextVersion({ LANDO_NPM_VERSION: "4.0.0-next.local" })).toBe("4.0.0-next.local");
  });

  test("marks packages publishable on the requested npm dist-tag", () => {
    expect(
      preparePackageJson(
        {
          name: "@lando/sdk",
          version: "0.0.0",
          private: true,
        },
        "4.0.0-next.7",
        "next",
      ),
    ).toMatchObject({
      version: "4.0.0-next.7",
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
      "4.0.0-next.7",
      "next",
    );

    expect(prepared.dependencies).toEqual({
      "@lando/container-runtime": "4.0.0-next.7",
      "@lando/provider-lando": "4.0.0-next.7",
      "@lando/sdk": "4.0.0-next.7",
      effect: "^3.21.2",
    });
    expect(prepared.peerDependencies).toEqual({
      "@lando/core": "4.0.0-next.7",
    });
  });

  test("release orchestrator publishes dev workspaces on the dev tag", async () => {
    const source = await Bun.file(releaseScriptPath).text();

    expect(source).toContain("prepareNpmDevPackages");
    expect(source).not.toContain("prepareNpmAlphaPackages");
    expect(source).not.toContain("prepareNpmBetaPackages");
    expect(source).toContain("releasePackageNames.map");
    expect(source).toContain("npm publish --workspace ${packageName} --access public --tag dev --provenance");
    expect(source).toContain("npm view @lando/core dist-tags.dev --json");
    expect(source).toContain("4\\\\.0\\\\.0-dev\\\\.");
  });

  test("marks packages publishable on dist-tag dev at 4.0.0-dev.N", () => {
    expect(
      preparePackageJson(
        {
          name: "@lando/engine",
          version: "0.0.0",
          private: true,
        },
        "4.0.0-dev.42",
        "dev",
      ),
    ).toMatchObject({
      version: "4.0.0-dev.42",
      private: false,
      publishConfig: { tag: "dev", access: "public" },
    });
  });

  test("packs a prepared workspace package as unsigned 4.0.0-dev.N on tag dev", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-npm-dev-pack-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "index.js"), "export {};\n");

      const prepared = preparePackageJson(
        {
          name: "@lando/engine",
          version: "0.0.0",
          private: true,
          files: ["src"],
          dependencies: {
            "@lando/sdk": "workspace:*",
            "@lando/paths": "workspace:*",
            effect: "^3.21.2",
          },
        },
        "4.0.0-dev.42",
        "dev",
      );
      await writeFile(join(root, "package.json"), `${JSON.stringify(prepared, null, 2)}\n`);

      const packDestination = join(root, "packed");
      await mkdir(packDestination);

      const packEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== "NPM_TOKEN" && key !== "NODE_AUTH_TOKEN"),
      );
      const npmExecutable = Bun.which("npm");
      const packArgs =
        npmExecutable === null
          ? ["bun", "pm", "pack"]
          : [npmExecutable, "pack", "--ignore-scripts", "--pack-destination", packDestination];
      const packProc = Bun.spawn(packArgs, {
        cwd: root,
        env: packEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const packCode = await packProc.exited;
      if (packCode !== 0) {
        throw new Error(`pack failed (${packCode}): ${await new Response(packProc.stderr).text()}`);
      }

      const tarballDirs = npmExecutable === null ? [root, packDestination] : [packDestination, root];
      let tarballPath: string | undefined;
      for (const dir of tarballDirs) {
        const names = await readdir(dir);
        const tgz = names.find((name) => name.endsWith(".tgz"));
        if (tgz !== undefined) {
          tarballPath = join(dir, tgz);
          break;
        }
      }
      if (tarballPath === undefined) {
        throw new Error("pack produced no .tgz tarball");
      }

      const listProc = Bun.spawn(["tar", "-tzf", tarballPath], { stdout: "pipe", stderr: "pipe" });
      const listCode = await listProc.exited;
      if (listCode !== 0) {
        throw new Error(`tar list failed (${listCode}): ${await new Response(listProc.stderr).text()}`);
      }
      const listing = await new Response(listProc.stdout).text();
      expect(listing).not.toContain(".sig");
      expect(listing).not.toContain(".crt");
      expect(listing).not.toContain("SHA256SUMS.asc");
      expect(listing).not.toContain("installer");
      expect(listing).not.toContain("update-manifest");

      const extractDir = join(root, "extract");
      await mkdir(extractDir);
      const extractProc = Bun.spawn(["tar", "-xzf", tarballPath, "-C", extractDir, "package/package.json"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const extractCode = await extractProc.exited;
      if (extractCode !== 0) {
        throw new Error(
          `tar extract failed (${extractCode}): ${await new Response(extractProc.stderr).text()}`,
        );
      }

      const packedJson: unknown = JSON.parse(
        await readFile(join(extractDir, "package", "package.json"), "utf8"),
      );
      expect(packedJson).toMatchObject({
        version: "4.0.0-dev.42",
        private: false,
        dependencies: {
          "@lando/sdk": "4.0.0-dev.42",
          "@lando/paths": "4.0.0-dev.42",
          effect: "^3.21.2",
        },
        publishConfig: {
          tag: "dev",
          access: "public",
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
