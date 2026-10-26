import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { renderReleaseWorkflow } from "../../../scripts/build-release-workflow.ts";
import { CI_PLATFORMS, releaseBinaryFileName } from "../../../scripts/ci-platforms.ts";

const bash = process.env.LANDO_TEST_BASH ?? "bash";
const shellTest = test.skipIf(process.platform === "win32" && !process.env.LANDO_TEST_BASH);
const releaseAssets = [
  ...CI_PLATFORMS.map(releaseBinaryFileName),
  "SHA256SUMS",
  "THIRD_PARTY_NOTICES.md",
  "LICENSE",
  "NOTICE",
  "container-helper-go-LICENSE",
  "container-helper-go-PATENTS",
].sort();

const withRehearsal = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "lando-release-rehearsal-"));
  try {
    await mkdir(join(root, "bin"));
    await copyFile(join(import.meta.dirname, "fixtures/release-gh.sh"), join(root, "bin/gh"));
    await chmod(join(root, "bin/gh"), 0o755);
    await mkdir(join(root, "dist"));
    await mkdir(join(root, "plugins/service-lando/tomcat"), { recursive: true });
    for (const name of releaseAssets.filter((name) => name !== "SHA256SUMS")) {
      const path = ["LICENSE", "NOTICE"].includes(name)
        ? `plugins/service-lando/tomcat/${name}`
        : `dist/${name}`;
      await writeFile(join(root, path), `${name}\n`);
    }
    await writeFile(
      join(root, "dist/SHA256SUMS"),
      CI_PLATFORMS.map((platform) => {
        const name = releaseBinaryFileName(platform);
        return `${new Bun.CryptoHasher("sha256").update(`${name}\n`).digest("hex")}  ${name}\n`;
      }).join(""),
    );
    await writeFile(join(root, "expected-assets"), `${releaseAssets.join("\n")}\n`);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const rehearsePublish = async (root: string, scenario = "success") => {
  const workflow = Bun.YAML.parse(renderReleaseWorkflow()) as {
    jobs: { "dev-prerelease": { steps: { name?: string; run?: string }[] } };
  };
  const script = workflow.jobs["dev-prerelease"].steps.find(
    ({ name }) => name === "Publish dev prerelease",
  )?.run;
  if (script === undefined) throw new Error("Missing publication script");
  await writeFile(join(root, "gh.log"), "");
  const proc = Bun.spawn(
    [
      bash,
      "--noprofile",
      "--norc",
      "-euc",
      `export PATH="$PWD/bin:$PATH"\n${script.replace(/\$\{\{[^}]+\}\}/g, "fixture")}`,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        BASH_ENV: "",
        GH_TOKEN: "fixture",
        GH_SCENARIO: scenario,
        RELEASE_TAG: "v4.0.0-dev.42",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const calls = (await readFile(join(root, "gh.log"), "utf8")).split("\n").filter(Boolean);
  const draft = await readFile(join(root, "release/draft"), "utf8").catch(() => undefined);
  return { code, calls, draft: draft?.trim(), stdout, stderr };
};

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
    expect(workflow).toContain("gh api --method POST repos/{owner}/{repo}/releases");
    expect(workflow).toContain("gh release upload");
    expect(workflow).toContain("--name container-helper --dir dist/container-helper");
    expect(workflow).toContain("test -s dist/container-helper/licenses/go/LICENSE");
    expect(workflow).toContain("go_notices=(dist/container-helper-go-*)");
    const create = workflow.match(/^\s+release_id=.+$/m)?.[0];
    const upload = workflow.match(/^\s+if gh release upload .+$/m)?.[0];
    expect(create).toContain("-F draft=true");
    expect(create).toContain("-F prerelease=true");
    expect(create).not.toContain("dist/SHA256SUMS");
    expect(upload).toContain('"${go_notices[@]}"');
    expect(upload).toContain("dist/SHA256SUMS");
    expect(workflow).toContain("set -euo pipefail");
    expect(workflow).not.toContain("trap ");
    expect(workflow).not.toContain("gh release delete");
    expect(workflow).not.toContain("--method DELETE");
    expect(workflow).not.toContain("--cleanup-tag");
    expect(workflow).toContain("group: dev-prerelease-${{ github.run_number }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain('gh api --method PATCH "$release_api" -F draft=false');
    expect(workflow.indexOf("gh release upload")).toBeLessThan(workflow.indexOf("--method PATCH"));
    expect(workflow).toContain("v4.0.0-dev.${{ github.run_number }}");
    expect(workflow).toContain("dist/SHA256SUMS");
    expect(workflow).toContain("dist/THIRD_PARTY_NOTICES.md");
    expect(workflow).toContain(
      "cp dist/artifacts/darwin-arm64/THIRD_PARTY_NOTICES.md dist/THIRD_PARTY_NOTICES.md",
    );
    expect(workflow).toContain(
      "cmp dist/artifacts/windows-arm64/THIRD_PARTY_NOTICES.md dist/THIRD_PARTY_NOTICES.md",
    );
    expect(workflow).not.toContain("sha256sum lando > SHA256SUMS");
    expect(workflow).not.toContain("if-no-files-found");
  });

  shellTest("publishes only after every binary, checksum and notice is uploaded", async () => {
    await withRehearsal(async (root) => {
      const result = await rehearsePublish(root);
      expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({
        code: 0,
        stderr: "",
      });
      expect(result.draft).toBe("false");
      expect(result.calls).toHaveLength(4);
      expect(result.calls.at(-1)).toBe("api --method PATCH repos/{owner}/{repo}/releases/123 -F draft=false");
    });
  });

  for (const scenario of ["list-failure", "create-failure", "create-ambiguous", "invalid-id"]) {
    shellTest(`preserves uncertain creation without upload or cleanup: ${scenario}`, async () => {
      await withRehearsal(async (root) => {
        const result = await rehearsePublish(root, scenario);
        expect(result.code).toBe(scenario === "invalid-id" ? 1 : scenario === "list-failure" ? 40 : 41);
        expect(result.calls).toHaveLength(scenario === "list-failure" ? 1 : 2);
        expect(result.draft).toBe(["list-failure", "create-failure"].includes(scenario) ? undefined : "true");
        const rerun = await rehearsePublish(root);
        expect(rerun.code).toBe(result.draft === undefined ? 0 : 1);
      });
    });
  }

  shellTest("preserves a complete draft after an ambiguous upload response and blocks rerun", async () => {
    await withRehearsal(async (root) => {
      const result = await rehearsePublish(root, "upload-complete-ambiguous");
      expect(result.code).toBe(42);
      expect(result.draft).toBe("true");
      expect(result.calls).toHaveLength(3);
      expect((await readdir(join(root, "release/assets"))).sort()).toEqual(releaseAssets);
      const rerun = await rehearsePublish(root);
      expect(rerun.code).toBe(1);
      expect(rerun.calls).toHaveLength(1);
      expect(rerun.draft).toBe("true");
    });
  });

  for (const draft of ["true", "false"]) {
    shellTest(`preserves an existing unowned release with draft=${draft}`, async () => {
      await withRehearsal(async (root) => {
        await mkdir(join(root, "release/assets"), { recursive: true });
        await writeFile(join(root, "release/draft"), draft);
        await writeFile(join(root, "release/assets/keep"), "existing asset");
        const result = await rehearsePublish(root);
        expect(result.code).toBe(1);
        expect(result.calls).toHaveLength(1);
        expect(result.draft).toBe(draft);
        expect(await readFile(join(root, "release/assets/keep"), "utf8")).toBe("existing asset");
      });
    });
  }

  for (const scenario of ["publish-failure", "publish-ambiguous"]) {
    shellTest(`preserves the release after ${scenario}, including on rerun`, async () => {
      await withRehearsal(async (root) => {
        const result = await rehearsePublish(root, scenario);
        expect(result.code).toBe(43);
        expect(result.draft).toBe(scenario === "publish-failure" ? "true" : "false");
        expect(result.calls).toHaveLength(4);
        expect(result.calls.at(-1)).toContain("--method PATCH");
        const rerun = await rehearsePublish(root);
        expect(rerun.code).toBe(1);
        expect(rerun.calls).toHaveLength(1);
        expect(rerun.draft).toBe(result.draft);
      });
    });
  }

  for (const scenario of ["partial-upload", "upload-ambiguous", "upload-public", "upload-public-race"]) {
    shellTest(`retains the upload failure and preserves the release on ${scenario}`, async () => {
      await withRehearsal(async (root) => {
        const result = await rehearsePublish(root, scenario);
        expect(result.code).toBe(42);
        expect(result.draft).toBe(scenario.startsWith("upload-public") ? "false" : "true");
        expect(result.calls).toHaveLength(3);
        expect(result.calls.at(-1)).toStartWith("release upload ");
        expect(await readdir(join(root, "release/assets"))).toHaveLength(1);
        expect(result.stderr).toContain("preserving it");
        const rerun = await rehearsePublish(root);
        expect(rerun.code).toBe(1);
        expect(rerun.calls).toHaveLength(1);
        expect(rerun.draft).toBe(result.draft);
      });
    });
  }

  shellTest("preserves a public release on a successful rerun", async () => {
    await withRehearsal(async (root) => {
      expect((await rehearsePublish(root)).code).toBe(0);
      const rerun = await rehearsePublish(root);
      expect(rerun.code).toBe(1);
      expect(rerun.draft).toBe("false");
      expect(rerun.calls).toHaveLength(1);
    });
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
