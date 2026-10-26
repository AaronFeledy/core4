import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { emitGuideScenarioTests, parseGuideScenarioAst } from "../../../scripts/build-guide-scenarios.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");

test.each([
  { requested: undefined, exitCode: 0, summary: "1 skip" },
  { requested: "1", exitCode: 1, summary: "1 fail" },
])(
  "e2e without a socket returns $exitCode when opt-in is $requested",
  async ({ requested, exitCode, summary }) => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-gate-"));
    try {
      await symlink(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
      const guide = parseGuideScenarioAst(
        "docs/guides/socket-gate.mdx",
        '---\nid: socket-gate\nprovider: test\ndefaultLayer: e2e\n---\n<Guide><Scenario id="requires-socket"><Step name="version"><Run command="version" /></Step></Scenario></Guide>',
      );
      const [generated] = await emitGuideScenarioTests([guide], root);
      if (generated === undefined) throw new Error("Expected generated e2e scenario");
      const env = { ...process.env };
      Reflect.deleteProperty(env, "LANDO_TEST_PODMAN_SOCKET");
      Reflect.deleteProperty(env, "LANDO_GUIDE_E2E");
      if (requested !== undefined) env.LANDO_GUIDE_E2E = requested;
      env.LANDO_SCENARIO_E2E_BINARY = join(root, "must-not-execute");

      const child = Bun.spawn({
        cmd: [process.execPath, "test", join(root, generated)],
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);

      expect(code).toBe(exitCode);
      expect(output).toContain(summary);
      if (requested === "1") expect(output).toContain("LANDO_TEST_PODMAN_SOCKET");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
