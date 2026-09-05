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

type WorkflowJob = { readonly env?: Record<string, unknown> };
type Workflow = {
  readonly name?: unknown;
  readonly jobs?: Record<string, WorkflowJob>;
};

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
});
