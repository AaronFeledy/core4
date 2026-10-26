import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emitGuideScenarioTests, parseGuideScenarioAst } from "../../../scripts/build-guide-scenarios.ts";

test.each([0, 1])(
  "command verification enforces a declared nonzero exit against actual %s",
  async (actual) => {
    // Given: an executable command verification that expects a nonzero report exit.
    const root = await mkdtemp(join(tmpdir(), "lando-guide-verify-exit-"));
    const content = [
      "---",
      "id: verify-exit",
      "provider: test",
      "---",
      "<Guide>",
      '  <Scenario id="nonzero">',
      '    <Step name="verify">',
      '      <Verify command="report" expectExit={1} expect={{ stdout: "report-data" }} />',
      "    </Step>",
      "  </Scenario>",
      "</Guide>",
    ].join("\n");
    try {
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir");
      const guide = parseGuideScenarioAst("docs/guides/verify-exit.mdx", content);
      await emitGuideScenarioTests([guide], root);
      const path = join(root, "test/scenarios/generated/guides/verify-exit/nonzero.test.ts");
      const generated = await Bun.file(path).text();
      await Bun.write(
        path,
        generated.replace(
          'guideId: "verify-exit",',
          `guideId: "verify-exit", runCli: async () => ({ command: ["report"], exitCode: ${actual}, stdout: "report-data", stderr: "", events: [] }),`,
        ),
      );
      // When: the generated test executes the report through its command port.
      const child = Bun.spawnSync([process.execPath, "test", path], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      // Then: matching nonzero exit passes, while an unexpected success fails.
      expect(child.exitCode, child.stderr.toString()).toBe(actual === 1 ? 0 : 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
