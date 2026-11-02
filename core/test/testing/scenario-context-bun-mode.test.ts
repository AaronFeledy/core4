import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.skipIf(process.platform === "win32")(
  "runs the selected CLI without reentry flags when the runner starts in embedded Bun mode",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-bun-mode-"));
    try {
      const cli = join(root, "cli.sh");
      await writeFile(
        cli,
        '#!/bin/sh\nprintf \'{"bun":"%s","reentry":"%s"}\' "${BUN_BE_BUN-}" "${LANDO_DISALLOW_BUN_BE_BUN_REENTRY-}"\n',
      );
      await chmod(cli, 0o755);
      const source = `
import { ScenarioContextFactory } from "@lando/core/testing";
import { Effect } from "effect";
const result = await Effect.runPromise(ScenarioContextFactory.e2e(
  { guideId: "mongodb", scenarioId: "embedded-bun" }, (context) => context.runCli(["version"])));
process.stdout.write(result.stdout);
process.exitCode = result.exitCode;
`;
      const child = Bun.spawn([process.execPath, "-e", source], {
        cwd: resolve(import.meta.dir, "../../.."),
        env: {
          ...process.env,
          BUN_BE_BUN: "1",
          LANDO_DISALLOW_BUN_BE_BUN_REENTRY: "1",
          LANDO_SCENARIO_E2E_BINARY: cli,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual({ bun: "", reentry: "" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
