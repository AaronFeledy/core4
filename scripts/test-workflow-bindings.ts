import { resolve } from "node:path";
import type { TestOwnershipIssue } from "./test-ownership.ts";
import { type TestSelection, UNIT_SHARD_COUNT } from "./test-selections.ts";

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : undefined;

interface WorkflowJob {
  readonly runs: readonly string[];
  readonly shards: readonly number[];
}
const parseJobs = (source: string): ReadonlyMap<string, WorkflowJob> => {
  const parsed: unknown = Bun.YAML.parse(source);
  const jobs = record(record(parsed)?.jobs);
  return new Map(
    Object.entries(jobs ?? {}).map(([id, value]) => {
      const job = record(value);
      const steps = job?.steps;
      const shards = record(record(job?.strategy)?.matrix)?.shard;
      return [
        id,
        {
          runs: Array.isArray(steps)
            ? steps.flatMap((step: unknown) => {
                const entry = record(step);
                if (entry?.if === false || entry?.if === "false") return [];
                const run = entry?.run;
                return typeof run === "string" ? [run] : [];
              })
            : [],
          shards:
            Array.isArray(shards) &&
            shards.every((value: unknown): value is number => typeof value === "number")
              ? shards
              : [],
        },
      ];
    }),
  );
};

const invokes = (run: string, command: readonly string[]): boolean => {
  const escaped = command
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(String.raw`[\t ]+`);
  const environment = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+)[\t ]+)*`;
  return new RegExp(String.raw`(?:^|[;&|\n])[\t ]*${environment}${escaped}(?=$|[\s;&|])`, "mu").test(run);
};

export const checkWorkflowBindings = async (
  root: string,
  selections: readonly TestSelection[],
): Promise<readonly TestOwnershipIssue[]> => {
  const workflows = new Map<string, ReadonlyMap<string, WorkflowJob>>();
  for await (const path of new Bun.Glob("*.{yml,yaml}").scan({ cwd: root, onlyFiles: true })) {
    workflows.set(path, parseJobs(await Bun.file(resolve(root, path)).text()));
  }
  const issues: TestOwnershipIssue[] = [];
  for (const [workflow, jobs] of workflows) {
    for (const [job, { runs }] of jobs) {
      for (const run of runs) {
        if (/(?:^|[\s;&|])bun(?:[\t ]+--no-orphans)?[\t ]+test(?=$|[\s;&|])/mu.test(run))
          issues.push({
            code: "RAW_BUN_TEST",
            paths: [workflow, job],
            remediation:
              "Declare the files in scripts/test-selections.ts and replace raw Bun tests in the workflow generator with bun run test:selection <id>.",
          });
      }
    }
  }
  for (const selection of selections) {
    if (selection.jobs.length === 0)
      issues.push({
        code: "UNBOUND_SELECTION",
        paths: [selection.id],
        remediation:
          "Declare an executing workflow job in scripts/test-selections.ts, or record an intentional gap in MANUAL_TESTS in scripts/test-ownership.ts.",
      });
    for (const { workflow, job } of selection.jobs) {
      const runs = workflows.get(workflow)?.get(job)?.runs ?? [];
      const command =
        selection.runner === "go"
          ? ["bun", "run", "scripts/build-container-helper.ts", "--test"]
          : ["bun", "run", "test:selection", selection.id];
      if (!runs.some((run) => invokes(run, command)))
        issues.push({
          code: "UNBOUND_SELECTION",
          paths: [selection.id, workflow, job],
          remediation:
            "Add the declared runner step in the workflow generator and run bun run codegen, or correct its job binding in scripts/test-selections.ts.",
        });
    }
  }
  const unit = workflows.get("ci.yml")?.get("unit-tests-linux-x64-shard");
  const expected = Array.from({ length: UNIT_SHARD_COUNT }, (_, index) => index + 1);
  if (
    !unit?.runs.some((run) =>
      invokes(run, ["bun", "run", "test:unit:shard", `\${{ matrix.shard }}/${UNIT_SHARD_COUNT}`]),
    ) ||
    JSON.stringify(unit.shards) !== JSON.stringify(expected)
  )
    issues.push({
      code: "UNBOUND_SELECTION",
      paths: ["unit", "ci.yml", "unit-tests-linux-x64-shard"],
      remediation: `Run bun run test:unit:shard with matrix.shard equal to 1..${UNIT_SHARD_COUNT} in scripts/build-ci-workflow.ts, then run bun run codegen.`,
    });
  return issues;
};
