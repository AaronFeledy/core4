import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { renderTomcatBumpWorkflow } from "../../../scripts/build-tomcat-bump-workflow.ts";
import { RUNTIME_BUNDLE_ACTION_PINS } from "../../../scripts/runtime-bundle-supply-chain.ts";

const Workflow = Schema.Struct({
  on: Schema.Struct({
    schedule: Schema.Array(Schema.Struct({ cron: Schema.String })),
    workflow_dispatch: Schema.Null,
  }),
  jobs: Schema.Struct({
    bump: Schema.Struct({ steps: Schema.Array(Schema.Struct({ run: Schema.optionalKey(Schema.String) })) }),
  }),
});
const proposalScript = () => {
  const workflow = Schema.decodeUnknownSync(Workflow)(Bun.YAML.parse(renderTomcatBumpWorkflow()));
  const script = workflow.jobs.bump.steps.find((step) => step.run?.includes("bun run update:tomcat"))?.run;
  if (script === undefined) throw new TypeError("Missing Tomcat proposal script");
  return script;
};
const runProposal = async (mode: string) => {
  const directory = await mkdtemp(join(tmpdir(), "tomcat-workflow-"));
  try {
    const log = join(directory, "actions");
    for (const executable of ["git", "gh", "bun"]) {
      const path = join(directory, executable);
      const body =
        executable === "git"
          ? 'if [ "$1" = diff ] && [ "$MODE" != current ]; then exit 1; fi'
          : executable === "bun"
            ? 'if [ "$1" = test ] && [ "$MODE" = failing ]; then exit 23; fi'
            : "";
      await Bun.write(
        path,
        `#!/bin/bash\nprintf '%s %s\\n' '${executable}' "$*" >> "$LOG"\n${body}\nexit 0\n`,
      );
      await chmod(path, 0o755);
    }
    const child = Bun.spawn(["bash", "-c", proposalScript()], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        RUNNER_TEMP: directory,
        LOG: log,
        MODE: mode,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { exitCode, stderr, actions: await Bun.file(log).text() };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe("Tomcat bump workflow", () => {
  test("matches generated YAML and uses reviewed actions with no persisted credentials", async () => {
    // Given / When
    const workflow = renderTomcatBumpWorkflow();
    const committed = await Bun.file(
      resolve(import.meta.dirname, "../../../.github/workflows/tomcat-bump.yml"),
    ).text();
    // Then
    expect(committed).toBe(workflow);
    expect(() => Schema.decodeUnknownSync(Workflow)(Bun.YAML.parse(workflow))).not.toThrow();
    expect(workflow).toContain(`uses: ${RUNTIME_BUNDLE_ACTION_PINS.checkout}`);
    expect(workflow).toContain(`uses: ${RUNTIME_BUNDLE_ACTION_PINS.setupBun}`);
    expect(workflow).toContain("persist-credentials: false");
  });
  test.skipIf(process.platform === "win32")("does not propose unchanged pins", async () => {
    // Given / When
    const result = await runProposal("current");
    // Then
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.actions).not.toContain("git push");
    expect(result.actions).not.toContain("gh pr create");
  });
  test.skipIf(process.platform === "win32")(
    "stops before publishing when candidate checks fail",
    async () => {
      // Given / When
      const result = await runProposal("failing");
      // Then
      expect(result.exitCode, result.stderr).toBe(23);
      expect(result.actions).not.toContain("git push");
      expect(result.actions).not.toContain("gh pr create");
      expect(result.actions).not.toContain("gh workflow run");
    },
  );
  test.skipIf(process.platform === "win32")(
    "merges the rolling branch and explicitly dispatches live CI after a successful proposal",
    async () => {
      // Given / When
      const result = await runProposal("changed");
      const ci = await Bun.file(resolve(import.meta.dirname, "../../../.github/workflows/ci.yml")).text();
      // Then
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.actions).toContain("git merge --no-edit origin/main");
      expect(result.actions).toContain("git push origin HEAD:automation/tomcat-bump");
      expect(result.actions).toContain("gh pr create --base main");
      expect(result.actions).toContain("gh workflow run ci.yml --ref automation/tomcat-bump");
      expect(result.actions).not.toContain("--force");
      expect(ci).toContain("bun test plugins/service-lando/test/*.integration.test.ts");
    },
    20_000,
  );
});
