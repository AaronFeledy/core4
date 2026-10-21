import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildContainerHelperAssets } from "../../../scripts/build-compiled-binary.ts";
import { releaseGitHubAssetPaths, runRelease } from "../../../scripts/release.ts";
import { containerHelperNotices } from "../../src/container-helper/notices.ts";
import { CONTAINER_HELPER_SOURCE_ROOT } from "../../src/container-helper/source.ts";
import { withCwd, withEnvVar } from "../_support/temp-cwd.ts";
import { stubContainerHelperDir } from "../build/fixtures/container-helper-stubs.ts";

test("the Lando build includes the pinned Go license and its notice inventory", async () => {
  const dist = join(CONTAINER_HELPER_SOURCE_ROOT, "dist");
  const files = await containerHelperNotices(dist);
  expect(files).toContain(join(dist, "licenses/go/LICENSE"));
  expect(await readFile(join(dist, "licenses/go/LICENSE"), "utf8")).toContain("The Go Authors");
});

test("compilation refuses helper binaries without their license", async () => {
  const root = await stubContainerHelperDir();
  try {
    await rm(join(root, "licenses/go/LICENSE"));
    await withEnvVar("LANDO_CONTAINER_HELPER_DIR", root, async () => {
      await expect(buildContainerHelperAssets(root)).rejects.toMatchObject({
        _tag: "ContainerHelperNoticeError",
        remediation: expect.stringContaining("build-container-helper.ts --test"),
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release refuses a prebuilt helper artifact without its license", async () => {
  const root = await stubContainerHelperDir();
  try {
    await rm(join(root, "licenses/go/LICENSE"));
    await expect(
      runRelease({
        target: "binary",
        throughStage: "2-container-helper",
        env: { LOCAL_REHEARSAL: "1", LANDO_CONTAINER_HELPER_DIR: root },
        deprecationGate: async () => ({ ok: true, offenders: [] }),
        manifestGate: async () => ({ ok: true, violations: [] }),
        runner: { spawn: async () => {}, shell: async () => {} },
        logger: () => {},
      }),
    ).rejects.toMatchObject({
      _tag: "ReleaseStageError",
      stageId: "2-container-helper",
      cause: { _tag: "ContainerHelperNoticeError" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release assets contain complete Go notices without colliding with Tomcat LICENSE", async () => {
  const root = await stubContainerHelperDir();
  try {
    const provenance = { path: "dist/provenance.json", sha256: "fixture" };
    const manifest = {
      artifacts: {
        binary: {
          kind: "binary",
          path: "dist/lando-linux-x64",
          sha256: "fixture",
          sbom: { path: "dist/sbom.json", sha256: "fixture" },
          provenance,
        },
      },
    };
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist/release-artifacts.json"), JSON.stringify(manifest));
    await withCwd(root, async () => {
      const assets = await releaseGitHubAssetPaths({
        target: "binary",
        env: {
          LANDO_CONTAINER_HELPER_DIR: root,
          LANDO_RELEASE_PLATFORM: "linux-x64",
          LANDO_RELEASE_VERSION: "4.0.0-dev.42",
        },
        localRehearsal: false,
        runner: { spawn: async () => {}, shell: async () => {} },
        logger: () => {},
        now: () => 0,
      });
      expect(assets).toContain("dist/container-helper-go-LICENSE");
      expect(assets).toContain("plugins/service-lando/tomcat/LICENSE");
      expect(await readFile("dist/container-helper-go-LICENSE", "utf8")).toBe("fixture Go license\n");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dry-run library pack includes both built helpers and every toolchain notice", async () => {
  const proc = Bun.spawn([process.execPath, "pm", "pack", "--dry-run", "--ignore-scripts"], {
    cwd: resolve(CONTAINER_HELPER_SOURCE_ROOT, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect({ code, error: code === 0 ? "" : stderr }).toEqual({ code: 0, error: "" });
  const listing = stdout + stderr;
  for (const arch of ["x64", "arm64"])
    expect(listing).toContain(`container-helper/dist/linux-${arch}/lando-container-helper`);
  const notices = await containerHelperNotices(join(CONTAINER_HELPER_SOURCE_ROOT, "dist"));
  for (const notice of notices)
    expect(listing).toContain(`container-helper/dist/licenses/go/${notice.split("/").at(-1)}`);
  expect(listing).toContain("container-helper/dist/source-digest");
  expect(listing).toContain("container-helper/dist/licenses/go/files.json");
});
