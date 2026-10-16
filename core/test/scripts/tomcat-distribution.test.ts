import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "bun:test";

import serviceManifest from "../../../plugins/service-lando/package.json";
import { renderReleaseWorkflow } from "../../../scripts/build-release-workflow.ts";
import { CI_PLATFORMS, releaseBinaryFileName } from "../../../scripts/ci-platforms.ts";
import { preparePackageJson } from "../../../scripts/prepare-npm-dev-packages.ts";
import { RELEASE_STAGES } from "../../../scripts/release.ts";
import { withCwd } from "../_support/temp-cwd.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const tomcatPath = "plugins/service-lando/tomcat";
const notices = ["LICENSE", "NOTICE"] as const;

const withFixture = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "lando-tomcat-distribution-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const runCommand = async (cmd: readonly string[], cwd: string): Promise<void> => {
  const proc = Bun.spawn([...cmd], {
    cwd,
    env: { ...process.env, BASH_ENV: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect({ code, diagnostics: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, diagnostics: "" });
};

// Exercise the real publication shell, replacing only the remote GitHub transport.
const publishLocally = async (script: string, root: string): Promise<void> => {
  await mkdir(join(root, "published"));
  await cp(resolve(repoRoot, tomcatPath), join(root, tomcatPath), { recursive: true });
  await runCommand(
    [
      "bash",
      "-euc",
      `RELEASE_TAG=v4.0.0-dev.42
      gh() {
        [ "$1 $2" = "release create" ] || return 0
        shift 3
        for asset in "$@"; do
          case "$asset" in --*) break;; esac
          cp "$asset" "published/$(basename "$asset")" || return
        done
      }
      ${script}`,
    ],
    root,
  );
};

test("delivers complete Tomcat notices when the service plugin is packed for publication", async () => {
  // Given: the real package tree and the same manifest preparation used by publishing.
  await withFixture(async (root) => {
    await cp(resolve(repoRoot, "plugins/service-lando"), root, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify(preparePackageJson(serviceManifest, "4.0.0-dev.42")),
    );

    // When: Bun creates the recipient's package archive.
    await runCommand([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", "service.tgz"], root);
    await mkdir(join(root, "extracted"));
    await runCommand(["tar", "-xzf", "service.tgz", "-C", "extracted"], root);

    // Then: the full readable files accompany the generated XML, without shipping raw baselines.
    for (const name of notices) {
      expect(await readFile(join(root, "extracted/package/tomcat", name), "utf8")).toBe(
        await readFile(resolve(repoRoot, tomcatPath, name), "utf8"),
      );
    }
    expect(
      await Bun.file(join(root, "extracted/package/src/services/generated/tomcat-catalog.ts")).exists(),
    ).toBe(true);
    expect(await Bun.file(join(root, "extracted/package/tomcat/server-9.xml")).exists()).toBe(false);
  });
});

test.skipIf(process.platform === "win32")(
  "delivers complete Tomcat notices beside all binaries when the dev release is published",
  async () => {
    // Given: the CI binary artifacts and generated publication command.
    const workflow = renderReleaseWorkflow();
    const publish = workflow.match(/^\s+(gh release create .+)$/m)?.[1];
    if (publish === undefined) throw new Error("Missing dev publication command");
    await withFixture(async (root) => {
      await mkdir(join(root, "dist"));
      for (const name of [...CI_PLATFORMS.map(releaseBinaryFileName), "SHA256SUMS"]) {
        await writeFile(join(root, "dist", name), name);
      }

      // When: the actual release command hands its assets to the transport.
      await publishLocally(publish.replace(/\$\{\{[^}]+\}\}/g, "fixture"), root);

      // Then: binary recipients can read complete companion files from the same release.
      for (const name of notices) {
        expect(await readFile(join(root, "published", name), "utf8")).toBe(
          await readFile(resolve(repoRoot, tomcatPath, name), "utf8"),
        );
      }
      for (const platform of CI_PLATFORMS) {
        expect(await readFile(join(root, "published", releaseBinaryFileName(platform)), "utf8")).toBe(
          releaseBinaryFileName(platform),
        );
      }
      expect(workflow).toContain("ref: ${{ github.event.workflow_run.head_sha }}");
    });
  },
);

test.skipIf(process.platform === "win32")(
  "delivers complete Tomcat notices when the manual binary release is published",
  async () => {
    // Given: the manual release stage's binary manifest and companion artifacts.
    const stage = RELEASE_STAGES.find(({ id }) => id === "13-publish");
    if (stage === undefined) throw new Error("Missing publish stage");
    await withFixture(async (root) => {
      await mkdir(join(root, "dist"));
      const artifact = { path: "dist/lando-linux-x64", sha256: "fixture" };
      const sbom = { path: "dist/sbom.json", sha256: "fixture" };
      const provenance = { path: "dist/provenance.json", sha256: "fixture" };
      for (const name of [
        "lando-linux-x64",
        "lando-linux-x64.sig",
        "lando-linux-x64.crt",
        "sbom.json",
        "provenance.json",
        "provenance.json.sig",
        "provenance.json.crt",
        "SHA256SUMS",
        "SHA256SUMS.asc",
        "SHA256SUMS.sig",
        "SHA256SUMS.crt",
        "SHA512SUMS",
        "SHA512SUMS.asc",
        "update-manifest.json",
        "update-manifest.json.sig",
        "update-manifest.json.crt",
        "release-notes.md",
      ])
        await writeFile(join(root, "dist", name), name);
      await writeFile(
        join(root, "dist/release-artifacts.json"),
        JSON.stringify({
          schemaVersion: 1,
          artifacts: { binary: { ...artifact, kind: "binary", sbom, provenance } },
        }),
      );

      // When: stage 13 publishes through its real shell, without compiling or contacting GitHub.
      await withCwd(root, () =>
        stage.run({
          target: "binary",
          env: {
            GH_TOKEN: "fixture",
            LANDO_RELEASE_PLATFORM: "linux-x64",
            LANDO_RELEASE_VERSION: "4.0.0-dev.42",
          },
          localRehearsal: false,
          runner: { spawn: async () => {}, shell: async ({ script }) => publishLocally(script, root) },
          logger: () => {},
          now: () => 0,
        }),
      );

      // Then: the signed-release path delivers the same full readable companion files.
      for (const name of notices) {
        expect(await readFile(join(root, "published", name), "utf8")).toBe(
          await readFile(resolve(repoRoot, tomcatPath, name), "utf8"),
        );
      }
    });
  },
);
