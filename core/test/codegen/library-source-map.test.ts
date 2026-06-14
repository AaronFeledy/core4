import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { buildGuideScenarioTests } from "../../../scripts/build-guide-scenarios.ts";
import { rewriteScenarioSourceMappedOutput } from "../../../scripts/test-reporters/scenario-source-mapper.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");

const linkNodeModules = async (root: string): Promise<void> => {
  await symlink(resolve(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
};

describe("library-mode guide scenario source maps", () => {
  test("rewrites failing generated library code stacks to the source MDX Run line", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-library-source-map-"));
    try {
      const guidePath = "docs/guides/library-source-map.mdx";
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, guidePath),
        [
          "---",
          "id: library-source-map-guide",
          "provider: test",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="fails">',
          '    <Step name="run">',
          '      <Run runtime="library" code={`expect("actual").toBe("expected");`} displayCode={`expect failure`} />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      await linkNodeModules(root);

      const written = await buildGuideScenarioTests(root);
      const generatedPath = join(root, written[0] ?? "");
      const proc = Bun.spawnSync({
        cmd: [process.execPath, "test", generatedPath],
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode).not.toBe(0);

      const rewritten = rewriteScenarioSourceMappedOutput(proc.stderr.toString(), { repoRoot });
      expect(rewritten).toContain(`${guidePath}:9`);
      expect(rewritten).toContain("library-source-map-guide:fails");
      expect(rewritten).not.toContain(`${written[0]}:9`);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
