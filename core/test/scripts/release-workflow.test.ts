import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { renderReleaseWorkflow } from "../../../scripts/build-release-workflow.ts";
import { CI_PLATFORMS, releaseBinaryFileName } from "../../../scripts/ci-platforms.ts";

const extractDraftTrapScript = (workflow: string): string => {
  const lines = workflow.split("\n");
  const createIndex = lines.findIndex((line) => /^\s+gh release create /.test(line));
  if (createIndex === -1) throw new Error("Missing gh release create");
  const script = ["set -euo pipefail", "go_notices=(dist/container-helper-go-*)"];
  for (const line of lines.slice(createIndex)) {
    if (!/^\s+/.test(line) || line.trim() === "") break;
    script.push(line.trim());
  }
  return script.join("\n").replace(/\$\{\{[^}]+\}\}/g, "fixture");
};

const rehearsePublish = async (
  failUpload: boolean,
): Promise<{ readonly code: number; readonly calls: readonly string[] }> => {
  const root = await mkdtemp(join(tmpdir(), "lando-release-rehearsal-"));
  const log = join(root, "gh.log");
  try {
    const proc = Bun.spawn(
      [
        "bash",
        "-euc",
        `RELEASE_TAG=v4.0.0-dev.42
        gh() {
          echo "$*" >> "$GH_CALL_LOG"
          if [ "$1 $2" = "release upload" ] && [ "\${FAIL_UPLOAD:-}" = "1" ]; then return 1; fi
        }
        ${extractDraftTrapScript(renderReleaseWorkflow())}`,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          BASH_ENV: "",
          FAIL_UPLOAD: failUpload ? "1" : "",
          GH_CALL_LOG: log,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const calls = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
    return { code, calls };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("gh release upload");
    expect(workflow).toContain("--name container-helper --dir dist/container-helper");
    expect(workflow).toContain("test -s dist/container-helper/licenses/go/LICENSE");
    expect(workflow).toContain("go_notices=(dist/container-helper-go-*)");
    const create = workflow.match(/^\s+gh release create .+$/m)?.[0];
    const upload = workflow.match(/^\s+gh release upload .+$/m)?.[0];
    expect(create).toContain("--draft");
    expect(create).toContain("--prerelease");
    expect(create).not.toContain("dist/SHA256SUMS");
    expect(upload).toContain('"${go_notices[@]}"');
    expect(upload).toContain("dist/SHA256SUMS");
    expect(workflow).toContain("set -euo pipefail");
    expect(workflow).toContain(`trap 'gh release delete "$RELEASE_TAG" --yes 2>/dev/null || true' ERR`);
    expect(workflow).toContain("trap - ERR");
    expect(workflow).toContain('gh release edit "$RELEASE_TAG" --draft=false');
    expect(workflow.indexOf("gh release delete")).toBeLessThan(workflow.indexOf("gh release create"));
    expect(workflow.indexOf("gh release create")).toBeLessThan(
      workflow.indexOf(`trap 'gh release delete "$RELEASE_TAG" --yes 2>/dev/null || true' ERR`),
    );
    expect(
      workflow.indexOf(`trap 'gh release delete "$RELEASE_TAG" --yes 2>/dev/null || true' ERR`),
    ).toBeLessThan(workflow.indexOf("gh release upload"));
    expect(workflow.indexOf("gh release upload")).toBeLessThan(workflow.indexOf("gh release edit"));
    expect(workflow.indexOf('gh release edit "$RELEASE_TAG" --draft=false')).toBeLessThan(
      workflow.indexOf("trap - ERR"),
    );
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

  test.skipIf(process.platform === "win32")(
    "deletes the draft when upload fails and does not delete after publish",
    async () => {
      // Given: the generated publish script from create through trap-clear
      // When: upload fails
      const failed = await rehearsePublish(true);

      // Then: the ERR trap deletes the draft and never reaches edit
      expect(failed.code).not.toBe(0);
      expect(failed.calls.some((call) => call.startsWith("release create "))).toBe(true);
      expect(failed.calls.some((call) => call.startsWith("release upload "))).toBe(true);
      expect(failed.calls).toContain("release delete v4.0.0-dev.42 --yes");
      expect(failed.calls.some((call) => call.startsWith("release edit "))).toBe(false);

      // When: upload succeeds
      const published = await rehearsePublish(false);

      // Then: the release is published and the trap does not delete it
      expect(published.code).toBe(0);
      expect(published.calls.some((call) => call.startsWith("release delete "))).toBe(false);
      expect(published.calls.at(-1)).toBe("release edit v4.0.0-dev.42 --draft=false");
    },
  );

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
