import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const workflowsDir = resolve(repoRoot, ".github/workflows");

/**
 * Contexts GitHub does not evaluate in `jobs.<id>.env`. Using one there is not a
 * soft failure: GitHub rejects the whole workflow file, reports "workflow file
 * issue" with zero jobs, and falls back to showing the file path as the workflow
 * name. Job-level `env` may only use `github`, `needs`, `strategy`, `matrix`,
 * `vars`, `secrets`, and `inputs`.
 */
const CONTEXTS_INVALID_AT_JOB_LEVEL = ["runner", "steps", "job", "env"] as const;

const EXPRESSION = /\$\{\{(?<body>.*?)\}\}/gu;

type WorkflowJob = {
  readonly env?: Record<string, unknown>;
  readonly if?: unknown;
  readonly strategy?: {
    readonly matrix?: {
      readonly include?: ReadonlyArray<Record<string, unknown>>;
    };
  };
};
type Workflow = {
  readonly name?: unknown;
  readonly on?: {
    readonly pull_request?: unknown;
  };
  readonly jobs?: Record<string, WorkflowJob>;
};

const MATRIX_CONTEXT = /\bmatrix\s*\./u;

const contextsUsedIn = (value: string): ReadonlyArray<string> =>
  [...value.matchAll(EXPRESSION)].flatMap((match) => {
    const body = match.groups?.body ?? "";
    return [...body.matchAll(/(?<![.\w])(?<name>[a-z]+)\s*\./gu)].map(
      (reference) => reference.groups?.name ?? "",
    );
  });

const readWorkflows = async (): Promise<ReadonlyArray<readonly [string, Workflow]>> => {
  const entries = (await readdir(workflowsDir)).filter((entry) => entry.endsWith(".yml"));
  return Promise.all(
    entries.map(
      async (entry) =>
        [entry, Bun.YAML.parse(await Bun.file(resolve(workflowsDir, entry)).text()) as Workflow] as const,
    ),
  );
};

describe("workflow job-level env contexts", () => {
  test("never references a context GitHub cannot evaluate in job-level env", async () => {
    // Given: every committed workflow, generated or hand-written.
    const workflows = await readWorkflows();

    // When: job-level env values are scanned for context references.
    const violations = workflows.flatMap(([file, workflow]) =>
      Object.entries(workflow.jobs ?? {}).flatMap(([jobId, job]) =>
        Object.entries(job.env ?? {}).flatMap(([key, value]) =>
          contextsUsedIn(String(value))
            .filter((context) => CONTEXTS_INVALID_AT_JOB_LEVEL.some((invalid) => invalid === context))
            .map((context) => `${file} job ${jobId} env.${key} uses ${context}.*`),
        ),
      ),
    );

    // Then: none, otherwise GitHub refuses to run the file at all.
    expect(violations).toEqual([]);
    expect(workflows.length).toBeGreaterThan(0);
  });

  test("keeps every workflow's declared name parseable so runs are not attributed to the path", async () => {
    // Given: a workflow GitHub cannot parse is surfaced by its path, not its name.
    const workflows = await readWorkflows();

    // Then: every workflow declares a name, and never the raw file path.
    for (const [file, workflow] of workflows) {
      const name = workflow.name;
      expect(typeof name === "string" && name.length > 0).toBe(true);
      expect(name).not.toContain(".github/workflows/");
      expect(name).not.toBe(file);
    }
  });

  test("never references matrix in a job-level if", async () => {
    // Given: parsed workflow ASTs. GitHub evaluates job-level if before the
    // matrix expands, so `matrix.*` there is a workflow-file issue and no job starts.
    const workflows = await readWorkflows();

    const violations = workflows.flatMap(([file, workflow]) =>
      Object.entries(workflow.jobs ?? {}).flatMap(([jobId, job]) => {
        if (typeof job.if !== "string" || !MATRIX_CONTEXT.test(job.if)) return [];
        return [`${file} job ${jobId} if uses matrix.*`];
      }),
    );

    expect(violations).toEqual([]);
    expect(workflows.length).toBeGreaterThan(0);
  });

  test("splits provider-matrix so pull requests run only Docker latest", async () => {
    const parsed = Bun.YAML.parse(
      await Bun.file(resolve(workflowsDir, "provider-matrix.yml")).text(),
    ) as Workflow;
    const weekly = parsed.jobs?.["provider-contracts"];
    const dockerLatest = parsed.jobs?.["provider-contracts-docker-latest"];
    const weeklyCells = (weekly?.strategy?.matrix?.include ?? []).map((row) => row.cell);
    const prCells = (dockerLatest?.strategy?.matrix?.include ?? []).map((row) => row.cell);
    const pullRequest = parsed.on?.pull_request;
    const paths =
      pullRequest !== null && typeof pullRequest === "object" && "paths" in pullRequest
        ? pullRequest.paths
        : undefined;

    expect(typeof weekly?.if).toBe("string");
    expect(typeof dockerLatest?.if).toBe("string");
    expect(weekly?.if).toContain("github.event_name != 'pull_request'");
    expect(dockerLatest?.if).toContain("github.event_name == 'pull_request'");
    expect(typeof weekly?.if === "string" && MATRIX_CONTEXT.test(weekly.if)).toBe(false);
    expect(typeof dockerLatest?.if === "string" && MATRIX_CONTEXT.test(dockerLatest.if)).toBe(false);
    expect(weeklyCells).toContain("docker-engine-linux-latest");
    expect(weeklyCells.length).toBeGreaterThan(1);
    expect(prCells).toEqual(["docker-engine-linux-latest"]);
    expect(paths).toEqual([
      "container-runtime/**",
      "plugins/provider-docker/**",
      "scripts/provider-matrix*",
      "scripts/build-provider-matrix-workflow.ts",
      ".github/workflows/provider-matrix.yml",
    ]);
  });
});
