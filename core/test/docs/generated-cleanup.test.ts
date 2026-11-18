import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Transcript } from "@lando/sdk/docs/components";
import { Schema } from "effect";
import { renderScenarioTest } from "../../../scripts/guides/test-render.ts";
import { parseGuideScenarioAst } from "../../src/docs/guide-compiler/parser.ts";

const repo = resolve(import.meta.dir, "../../..");

const cases = [
  {
    name: "success",
    before: "check",
    teardown: "destroy",
    commands: ["check:app", "init:app", "destroy:app", "finish:app"],
  },
  {
    name: "failure",
    before: "fail",
    teardown: "destroy",
    commands: ["fail:app", "destroy:app", "finish:app"],
  },
  {
    name: "two failures",
    before: "fail",
    teardown: "broken-cleanup",
    commands: ["fail:app", "broken-cleanup:app", "finish:app"],
  },
  {
    name: "interruption",
    before: "interrupt",
    teardown: "destroy",
    commands: ["interrupt:app", "destroy:app", "finish:app"],
  },
  {
    name: "failed init",
    before: "check",
    teardown: "destroy",
    commands: ["destroy:<workspace>", "finish:<workspace>"],
  },
];

for (const { name, before, teardown, commands } of cases) {
  test.skipIf(process.platform === "win32")(
    `generated e2e cleanup on ${name}`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "guide-cleanup-"));
      const id = basename(root).toLowerCase();
      const file = join(repo, `${id}.test.ts`);
      const transcriptDir = join(repo, "dist", "transcripts", "guides", id);
      const binary = join(root, "lando");
      const calls = join(root, "calls");
      const socketPath = join(root, "provider.sock");
      const listener = Bun.listen({ unix: socketPath, socket: { data() {} } });
      try {
        await Bun.write(
          binary,
          `#!/bin/sh
printf '%s:%s\n' "$1" "\${PWD##*/}" >> "${calls}"
case "$1" in
  init) if [ "$2" = failed ]; then echo primary-step-failed >&2; exit 7; fi; mkdir -p -- "$2" ;;
  fail) echo primary-step-failed >&2; exit 7 ;;
  interrupt) kill -TERM "$PPID"; exec sleep 60 ;;
  broken-cleanup) echo teardown-failed >&2; exit 8 ;;
esac
`,
        );
        await chmod(binary, 0o755);
        const guide = parseGuideScenarioAst(
          "cleanup.mdx",
          `---
id: ${id}
provider: test
timeout: 10000
---
<Guide>
  <Scenario id="probe" layer="e2e" render>
    <Step name="init"><Run command="lando init ${name === "failed init" ? "failed" : "app"}" /></Step>
    <Step name="action"><Run command="lando ${before}" /></Step>
    <Step name="cleanup">
      <Cleanup />
      <Run command="lando ${teardown}" />
      <Run command="lando finish" />
    </Step>
    <Step name="after"><Run command="lando init ../later" /></Step>
  </Scenario>
</Guide>
`,
        );
        const [scenario] = guide.scenarios;
        if (scenario === undefined) throw new Error("Missing regression scenario");
        await Bun.write(file, renderScenarioTest(guide, scenario, undefined, "linux"));
        const proc = Bun.spawn([process.execPath, "test", file], {
          cwd: repo,
          env: {
            ...process.env,
            LANDO_GUIDE_E2E: "1",
            LANDO_SCENARIO_E2E_BINARY: binary,
            LANDO_TEST_PODMAN_SOCKET: socketPath,
          },
          stdout: "ignore",
          stderr: "pipe",
        });
        const [status, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

        expect(await Bun.file(calls).exists(), stderr).toBe(true);
        expect(
          (await Bun.file(calls).text())
            .trim()
            .replace(/:lando-scenario-[^\n]+/g, ":<workspace>")
            .split("\n"),
        ).toEqual(["init:<workspace>", ...commands]);
        expect(status, stderr).toBe(name === "success" ? 0 : 1);
        if (before === "fail" || name === "failed init") expect(stderr).toContain("primary-step-failed");
        if (teardown === "broken-cleanup")
          expect(stderr.indexOf("teardown-failed")).toBeGreaterThan(stderr.indexOf("primary-step-failed"));
        if (name === "interruption") expect(stderr).toContain("Interrupt");
        if (name === "success") {
          const transcript = Schema.decodeUnknownSync(Transcript)(
            await Bun.file(join(transcriptDir, "probe.json")).json(),
          );
          expect(transcript.frames.flatMap((frame) => (frame.kind === "run" ? [frame.command] : []))).toEqual(
            [["init", "app"], ["check"], ["destroy"], ["finish"], ["init", "../later"]],
          );
        }
      } finally {
        listener.stop(true);
        await Promise.all([
          rm(root, { recursive: true, force: true }),
          rm(file, { force: true }),
          rm(transcriptDir, { recursive: true, force: true }),
        ]);
      }
    },
    20_000,
  );
}
