import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Schema } from "effect";

const Workflow = Schema.Struct({
  jobs: Schema.Struct({
    bump: Schema.Struct({ steps: Schema.Array(Schema.Struct({ run: Schema.optionalKey(Schema.String) })) }),
    "report-failure": Schema.Struct({
      env: Schema.Record(Schema.String, Schema.String),
      steps: Schema.Array(Schema.Struct({ run: Schema.String })),
    }),
  }),
});

export const workflowScripts = (yaml: string) => {
  const { jobs } = Schema.decodeUnknownSync(Workflow)(Bun.YAML.parse(yaml));
  const proposal = jobs.bump.steps.find((step) => step.run?.includes("gh auth setup-git"))?.run;
  const failure = jobs["report-failure"].steps[0]?.run;
  if (proposal === undefined || failure === undefined) throw new TypeError("Missing workflow scripts");
  return { proposal, failure, failureEnv: jobs["report-failure"].env };
};

export type MaintenanceScenario = {
  readonly domain: "tomcat" | "compose";
  readonly mode?: "current" | "changed" | "checks-fail" | "update-fail" | "report-fail";
  readonly pending?: "bump" | "manual-only";
  readonly existingPr?: boolean;
};

// Real Git transport, fake GitHub and domain I/O only. No process-global cwd/env changes.
export const createMaintenanceFixture = async (scenario: MaintenanceScenario) => {
  const root = await mkdtemp(join(tmpdir(), "maintenance-workflow-"));
  const work = join(root, "work");
  const remote = join(root, "origin.git");
  const bin = join(root, "bin");
  const runnerTemp = join(root, "runner-temp");
  const log = join(root, "commands");
  const branch = `automation/${scenario.domain === "tomcat" ? "tomcat" : "compose-go"}-bump`;
  const owned =
    scenario.domain === "tomcat" ? "plugins/service-lando/tomcat/pins.json" : "vendor/compose/pin.json";
  const pin = (tag: string) =>
    JSON.stringify({
      tag,
      sourceUrl: `https://raw.githubusercontent.com/compose-spec/compose-go/${tag}/schema/compose-spec.json`,
      sha256: "a".repeat(64),
    });
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture author",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture author",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    PATH: `${bin}:${process.env.PATH}`,
    RUNNER_TEMP: runnerTemp,
    LOG: log,
    MODE: scenario.mode ?? "changed",
    EXISTING_PR: scenario.existingPr ? "71" : "",
    ISSUES: "[]",
    TAGS: scenario.mode === "current" || scenario.pending ? "v2.1.0\nv99.0.0-rc1" : "v2.2.0\nv99.0.0-rc1",
    NEW_PIN: pin("v2.2.0"),
    OWNED: owned,
    REAL_BUN: process.execPath,
  };
  const run = async (args: readonly string[], cwd = work, extraEnv = {}) => {
    const child = Bun.spawn([...args], { cwd, env: { ...env, ...extraEnv }, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  };
  const git = async (...args: string[]) => {
    const result = await run(["git", ...args]);
    if (result.exitCode !== 0) throw new TypeError(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    for (const directory of [work, bin, runnerTemp]) await mkdir(directory);
    await run(["git", "init", "--bare", remote], root).then((result) => {
      if (result.exitCode !== 0) throw new TypeError(result.stderr);
    });
    await git("init", "-b", "main");
    await git("config", "user.name", "Fixture author");
    await git("config", "user.email", "fixture@example.invalid");
    for (const [path, text] of Object.entries({
      [owned]: scenario.domain === "compose" ? pin("v2.1.0") : "old pins\n",
      "plugins/service-lando/tomcat/server-9.xml": "old nine\n",
      "plugins/service-lando/tomcat/server-10.xml": "old ten\n",
      "plugins/service-lando/tomcat/server-11.xml": "old eleven\n",
      "vendor/compose/compose-spec.json": "{}\n",
      "unrelated.txt": "original\n",
      "scripts/compose-vendor.ts": await Bun.file(
        resolve(import.meta.dirname, "../../../../scripts/compose-vendor.ts"),
      ).text(),
    })) {
      await mkdir(dirname(join(work, path)), { recursive: true });
      await Bun.write(join(work, path), text);
    }
    await git("add", ".");
    await git("commit", "-m", "initial");
    await git("remote", "add", "origin", remote);
    await git("push", "origin", "main");
    let manualCommit = "";
    if (scenario.pending) {
      await git("checkout", "-b", branch);
      if (scenario.pending === "bump") {
        await Bun.write(join(work, owned), scenario.domain === "compose" ? pin("v2.2.0") : "new pins\n");
        await git("add", owned);
        await git("commit", "-m", "pending bump");
      }
      await Bun.write(join(work, "manual.txt"), "human classification\n");
      await git("add", "manual.txt");
      await git("commit", "-m", "human review");
      manualCommit = await git("rev-parse", "HEAD");
      await git("push", "origin", branch);
      await git("checkout", "main");
      await Bun.write(join(work, "main-advance.txt"), "new main\n");
      await git("add", "main-advance.txt");
      await git("commit", "-m", "advance main");
      await git("push", "origin", "main");
    }
    for (const [name, script] of Object.entries({
      gh: `printf '%s\\n' "gh $* repo=\${GH_REPO:-}" >> "$LOG"
case "$1 $2" in
  'api --paginate') printf '%s\\n' "$TAGS" ;;
  'pr list') printf '%s' "$EXISTING_PR" ;;
  'issue list') test -n "$GH_REPO"; printf '%s' "$ISSUES" | jq -r "\${@: -1}" ;;
esac`,
      bun: `if [ "$1" = -e ]; then exec "$REAL_BUN" "$@"; fi
printf '%s\\n' "bun $*" >> "$LOG"
case "$1 $2" in
  'run update:tomcat'|'run codegen:compose-vendor')
    if [ "$MODE" = update-fail ]; then exit 22; fi
    if [ "$MODE" != current ]; then
      if [ "$2" = update:tomcat ]; then printf 'new pins\\n' > "$OWNED"; else printf '%s' "$NEW_PIN" > "$OWNED"; fi
      printf 'dirty\\n' > unrelated.txt
      git add unrelated.txt
      printf 'untracked\\n' > untracked.txt
    fi ;;
  'test '*) if [ "$MODE" = checks-fail ]; then exit 23; fi ;;
  'run scripts/report-'*)
    if [ "$MODE" = report-fail ]; then exit 24; fi
    printf 'candidate report\\n' ;;
esac`,
    })) {
      await Bun.write(join(bin, name), `#!/bin/bash\nset -euo pipefail\n${script}\n`);
      await chmod(join(bin, name), 0o755);
    }
    await Bun.write(log, "");
    return {
      root,
      work,
      remote,
      branch,
      owned,
      manualCommit,
      git,
      runnerTemp,
      proposal: (yaml: string) => run(["bash", "-c", workflowScripts(yaml).proposal]),
      failure: (
        yaml: string,
        issues: readonly { readonly number: number; readonly title: string }[] = [],
      ) => {
        const scripts = workflowScripts(yaml);
        const failureEnv = Object.fromEntries(
          Object.entries(scripts.failureEnv).map(([key, value]) => [
            key,
            value
              .replaceAll("${{ github.repository }}", "fixture/repository")
              .replaceAll("${{ github.server_url }}", "https://example.invalid")
              .replaceAll("${{ github.run_id }}", "42")
              .replaceAll("${{ github.token }}", "fixture-token"),
          ]),
        );
        return run(["bash", "-c", scripts.failure], runnerTemp, {
          ...failureEnv,
          ISSUES: JSON.stringify(issues),
        });
      },
      commands: () => Bun.file(log).text(),
      [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
};
