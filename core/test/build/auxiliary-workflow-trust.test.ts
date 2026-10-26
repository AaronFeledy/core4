import { expect, test } from "bun:test";
import { resolve } from "node:path";
import * as Schema from "effect/Schema";

const workflowSchema = Schema.Struct({
  on: Schema.Record(Schema.String, Schema.Unknown),
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      "runs-on": Schema.Union([Schema.String, Schema.Array(Schema.String)]),
      if: Schema.optional(Schema.String),
    }),
  ),
});

test.each(["drupal-journey", "rails-journey", "platform-readiness", "workflow-performance"])(
  "%s cannot execute self-hosted evidence from a PR or manual feature branch",
  async (name) => {
    const source = await Bun.file(
      resolve(import.meta.dirname, `../../../.github/workflows/${name}.yml`),
    ).text();
    const workflow = Schema.decodeUnknownSync(workflowSchema)(Bun.YAML.parse(source));
    expect(Object.keys(workflow.on)).not.toContain("pull_request");
    expect(Object.keys(workflow.on)).toContain("workflow_dispatch");
    const hosted = Object.values(workflow.jobs).filter((job) => job["runs-on"].includes("self-hosted"));
    if (name !== "workflow-performance") expect(hosted).toHaveLength(4);
    for (const job of hosted) {
      expect(job.if).toBeDefined();
      const evaluate = new Function("github", `return ${job.if}`);
      for (const [event_name, ref, allowed] of [
        ["pull_request", "refs/heads/main", false],
        ["workflow_dispatch", "refs/heads/topic", false],
        ["schedule", "refs/heads/topic", false],
        ["push", "refs/heads/main", false],
        ["workflow_dispatch", "refs/heads/main", true],
        ["schedule", "refs/heads/main", true],
      ] as const) {
        const actual: unknown = evaluate({ event_name, ref });
        expect({ event_name, ref, allowed: actual }).toEqual({ event_name, ref, allowed });
      }
    }
  },
);
