import { expect, expectTypeOf, it } from "bun:test";
import { isMapping } from "@actions/workflow-parser";
import { sha256Hex } from "@lando/sdk/digest";
import { createSecretRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import {
  loadActionMetadata,
  parseActionReference,
  resolveFixtureReference,
  verifyFixtureSource,
} from "../src/actions/source/index.ts";
import { selectEvent } from "../src/events/index.ts";
import { parseWorkflowLanguage } from "../src/language/parse.ts";
import { workflowEventTriggers } from "../src/planning/events.ts";
import { advancePlan, planWorkflow } from "../src/planning/plan.ts";
import { WorkflowPlanResult, projectPlan } from "../src/planning/project.ts";
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const verifiedFixture = async () => {
  const commit = "a".repeat(40);
  const uses = `owner/fixture@${commit}`;
  const reference = await run(parseActionReference(uses, { file: "ci.yml" }));
  if (reference.kind !== "repository") throw new Error("expected repository");
  const resolved = await run(resolveFixtureReference(reference));
  const files = [
    {
      path: "action.yml",
      bytes: new TextEncoder().encode(
        "name: fixture\ndescription: fixture\nruns:\n  using: node24\n  main: main.js\n",
      ),
    },
    { path: "LICENSE", bytes: new TextEncoder().encode("MIT fixture license\n") },
  ];
  const verified = await run(
    verifyFixtureSource(
      resolved,
      {
        origin: "https://github.com",
        repository: "owner/fixture",
        commit,
        subpath: "",
        metadataPath: "action.yml",
        files: files.map((file) => ({
          path: file.path,
          size: file.bytes.length,
          sha256: sha256Hex(file.bytes),
        })),
        licenses: ["LICENSE"],
      },
      files,
    ),
  );
  return { verified, uses };
};

it("composes upstream tokens, typed event inputs, verified metadata, deferred graph facts, and canonical Schema projection without workloads", async () => {
  expectTypeOf<Effect.Services<ReturnType<typeof planWorkflow>>>().toEqualTypeOf<never>();
  expectTypeOf<Effect.Services<ReturnType<typeof advancePlan>>>().toEqualTypeOf<never>();
  const secret = "private-planning-secret";
  const { verified, uses } = await verifiedFixture();
  expect((await run(loadActionMetadata(verified))).kind).toBe("node24");
  const parsed = await run(
    parseWorkflowLanguage(
      "ci.yml",
      `on:
  workflow_dispatch:
    inputs:
      enabled:
        type: boolean
        default: true
jobs:
  build:
    if: inputs.enabled
    outputs:
      publish: resolved-externally
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: [20, 22, 24]
    steps:
      - uses: ${uses}
      - &script
        run: echo ${secret}
      - *script
  publish:
    needs: build
    if: needs.build.outputs.publish == 'yes'
    runs-on: ubuntu-latest
    steps:
      - run: echo publish
  cleanup:
    needs: build
    if: always()
    runs-on: ubuntu-latest
    steps:
      - run: echo cleanup
`,
    ),
  );
  expect(isMapping(parsed.token)).toBe(true);
  expect(parsed.aliasProvenance).toHaveLength(1);
  const selected = await run(
    selectEvent(
      await run(workflowEventTriggers(parsed)),
      { mode: "supplied", name: "workflow_dispatch", payload: {}, inputs: { enabled: true } },
      { file: "ci.yml" },
    ),
  );
  if (selected.kind !== "selected") throw new Error("expected explicit selected event");
  const initial = await run(
    planWorkflow(parsed, {
      facts: { inputs: selected.inputs, github: { event_name: selected.name, event: { sensitive: secret } } },
      actionSources: [verified],
    }),
  );
  expect(initial.actions[0]?.kind).toBe("node24");
  expect(initial.legs.filter((leg) => leg.jobId === "build")).toHaveLength(3);
  expect(initial.jobs.find((job) => job.id === "publish")?.state).toBe("deferred");
  const advanced = await run(
    advancePlan(initial, {
      completions: initial.legs
        .filter((leg) => leg.jobId === "build")
        .map((leg) => ({ legId: leg.id, outcome: "success" as const, outputs: { publish: "yes" } })),
    }),
  );
  expect(advanced.legs.find((leg) => leg.jobId === "publish")?.state).toBe("ready");
  const projected = await run(projectPlan(advanced, createSecretRedactor([secret])));
  expect(Schema.is(WorkflowPlanResult)(projected)).toBe(true);
  expect(projected.assessment).toBe("execution-unassessed");
  const wire = JSON.stringify(projected);
  for (const privateText of [secret, "echo publish", "inputs.enabled", uses, "sensitive"])
    expect(wire).not.toContain(privateText);
  expect(JSON.stringify(advanced)).toBe('"<private Actions planning state>"');
});

it("requires the canonical host redactor and redacts authored identifiers before projection", async () => {
  const parsed = await run(
    parseWorkflowLanguage(
      "private/path.yml",
      "on: push\njobs:\n  private_job:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo private-script\n",
    ),
  );
  const plan = await run(planWorkflow(parsed));
  const result = await run(projectPlan(plan, createSecretRedactor(["private_job"])));
  expect(result.jobs[0]?.id).toBe("[redacted]");
  expect(JSON.stringify(result)).not.toContain("private/path");
});

it("fails bounded redaction without falling back to an unbounded call", async () => {
  const parsed = await run(
    parseWorkflowLanguage(
      "ci.yml",
      "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo safe\n",
    ),
  );
  const plan = await run(planWorkflow(parsed));
  let calls = 0;
  const failure = await run(
    Effect.flip(
      projectPlan(plan, {
        redactBounded: () => undefined,
        redact: () => {
          calls++;
          throw new Error("unbounded");
        },
      }),
    ),
  );
  expect(failure.code).toBe("projection-limit");
  expect(calls).toBe(0);
});

it("rejects supplied verified metadata that does not match authored uses", async () => {
  const { verified } = await verifiedFixture();
  const parsed = await run(
    parseWorkflowLanguage(
      "ci.yml",
      `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: owner/different@${"a".repeat(40)}
`,
    ),
  );
  expect(await run(Effect.flip(planWorkflow(parsed, { actionSources: [verified] })))).toMatchObject({
    code: "action-metadata-mismatch",
    source: { file: "ci.yml" },
  });
});
it.each([
  ["unsupported event", "on: issues\njobs:\n"],
  [
    "schedule timezone",
    "on:\n  schedule:\n    - cron: '0 0 * * *'\n      timezone: America/New_York\njobs:\n",
  ],
])("diagnoses %s instead of dropping authored intent", async (_name, prefix) => {
  const parsed = await run(
    parseWorkflowLanguage(
      "ci.yml",
      `${prefix}  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo safe
`,
    ),
  );
  const failure = await run(Effect.flip(workflowEventTriggers(parsed)));
  expect(failure._tag).toBe("ActionsEventError");
});
