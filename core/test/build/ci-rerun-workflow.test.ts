import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { renderCiRerunWorkflow } from "../../../scripts/build-ci-rerun-workflow.ts";
import { renderCiWorkflow } from "../../../scripts/build-ci-workflow.ts";

const workflowSchema = Schema.Struct({
  on: Schema.Unknown,
  permissions: Schema.Unknown,
  jobs: Schema.Struct({
    "rerun-abandoned": Schema.Struct({
      if: Schema.String,
      "runs-on": Schema.String,
      permissions: Schema.Unknown,
      steps: Schema.Tuple([
        Schema.Struct({
          run: Schema.String,
          uses: Schema.optionalKey(Schema.String),
          env: Schema.Record(Schema.String, Schema.String),
        }),
      ]),
    }),
  }),
});
const rendered = renderCiRerunWorkflow();
const workflow = Schema.decodeUnknownSync(workflowSchema)(Bun.YAML.parse(rendered));
const job = workflow.jobs["rerun-abandoned"];
const [step] = job.steps;

test("the committed workflow only retries ci and grants Actions write to the no-checkout job", async () => {
  const committed = await Bun.file(
    join(import.meta.dirname, "../../../.github/workflows/ci-rerun.yml"),
  ).text();
  expect(committed).toBe(rendered);
  expect(workflow.on).toEqual({ workflow_run: { workflows: ["ci"], types: ["completed"] } });
  expect(workflow.permissions).toEqual({});
  expect(job.permissions).toEqual({ actions: "write" });
  expect(job["runs-on"]).toBe("ubuntu-24.04");
  expect(step.uses).toBeUndefined();
  expect(step.env).toMatchObject({
    GH_REPO: "${{ github.repository }}",
    GH_TOKEN: "${{ github.token }}",
    RUN_ID: "${{ github.event.workflow_run.id }}",
  });
});

test.each([
  ["failure", 1, true],
  ["failure", 2, false],
  ["cancelled", 1, false],
  ["success", 1, false],
] as const)("admits a %s completion on attempt %i: %p", (conclusion, run_attempt, allowed) => {
  const evaluate = new Function("github", `return (${job.if.slice(3, -2)});`);
  expect(evaluate({ event: { workflow_run: { conclusion, run_attempt } } })).toBe(allowed);
});

test("the retry allowlist matches every validator in rendered ci.yml by its REST job name", () => {
  const { jobs } = Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Record(
        Schema.String,
        Schema.Struct({
          name: Schema.optionalKey(Schema.String),
          steps: Schema.Array(
            Schema.Struct({
              name: Schema.optionalKey(Schema.String),
              run: Schema.optionalKey(Schema.String),
            }),
          ),
        }),
      ),
    }),
  )(Bun.YAML.parse(renderCiWorkflow()));
  const validators = Object.entries(jobs).flatMap(([id, job]) =>
    job.steps
      .filter(({ run }) => run?.includes("scripts/validate-ci.ts"))
      .map(({ name }) => [job.name ?? id, name]),
  );
  expect(JSON.parse(step.env.CI_SUMMARY_VALIDATORS ?? "{}")).toEqual(Object.fromEntries(validators));
});

const abandoned = {
  name: "process-signal-tests-darwin (darwin-arm64, macos-15)",
  conclusion: "cancelled",
  steps: [],
};
const validationFailure = { name: "Validate selected job results", conclusion: "failure" };
const gateFailure = { name: "ci", conclusion: "failure", steps: [validationFailure] };
const runnerLoss = [
  abandoned,
  gateFailure,
  { ...gateFailure, name: "static-checks" },
  { name: "docs", conclusion: "skipped", steps: [] },
];
const ran = [{ name: "Run tests", conclusion: "failure" }];

test.skipIf(process.platform === "win32").each([
  ["runner loss and derived gate failures", runnerLoss, 1, ".github/workflows/ci.yml", true],
  [
    "a leaf failure on the next page",
    [...runnerLoss, { name: "tests", conclusion: "failure", steps: ran }],
    1,
    ".github/workflows/ci.yml",
    false,
  ],
  [
    "a cancellation after steps started",
    [...runnerLoss, { name: "tests", conclusion: "cancelled", steps: ran }],
    1,
    ".github/workflows/ci.yml",
    false,
  ],
  [
    "a gate setup failure",
    [abandoned, { ...gateFailure, steps: [{ name: "Install dependencies", conclusion: "failure" }] }],
    1,
    ".github/workflows/ci.yml",
    false,
  ],
  ["no abandoned jobs", [gateFailure], 1, ".github/workflows/ci.yml", false],
  ["a stale first-attempt event", runnerLoss, 2, ".github/workflows/ci.yml", false],
  ["a different workflow file with the same name", runnerLoss, 1, ".github/workflows/other.yml", false],
] as const)("rerun decision for %s", async (_description, jobs, attempt, path, shouldRerun) => {
  const root = await mkdtemp(join(tmpdir(), "ci-rerun-"));
  try {
    const gh = join(root, "gh");
    const log = join(root, "reruns");
    await Bun.write(log, "");
    await Bun.write(
      gh,
      `#!/bin/bash
case "$*" in
  'api --paginate repos/fixture/core4/actions/runs/42/attempts/1/jobs?per_page=100') printf '%s\\n' "$PAGES" ;;
  'api repos/fixture/core4/actions/runs/42 --jq '*) printf '%s\\n' "$RUN" | jq -r "$4" ;;
  'run rerun '*) printf '%s\\n' "$*" >> "$LOG" ;;
  *) exit 97 ;;
esac
`,
    );
    await chmod(gh, 0o755);
    const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
      cwd: root,
      env: {
        ...step.env,
        PATH: `${root}:${process.env.PATH}`,
        GH_REPO: "fixture/core4",
        GH_TOKEN: "fixture-token",
        RUN_ID: "42",
        LOG: log,
        RUN: JSON.stringify({ path, run_attempt: attempt }),
        PAGES: [jobs.slice(0, 1), jobs.slice(1)].map((jobs) => JSON.stringify({ jobs })).join("\n"),
      },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(await Bun.file(log).text()).toBe(shouldRerun ? "run rerun 42 --failed\n" : "");
    if (!shouldRerun) expect(result.stdout.toString()).toMatch(/^Skipping CI rerun: [^\n]+\n$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
