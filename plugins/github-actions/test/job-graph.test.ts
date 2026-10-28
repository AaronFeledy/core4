import { expect, it } from "bun:test";
import { Effect } from "effect";
import { validateJobGraph } from "../src/planning/graph.ts";

it("validates all identities and edges before expansion with deterministic topological order", async () => {
  expect(
    await Effect.runPromise(
      validateJobGraph([
        { id: "last", needs: ["first"] },
        { id: "first", needs: [] },
        { id: "other", needs: [] },
      ]),
    ),
  ).toEqual(["first", "last", "other"]);
});
it.each([
  [
    "duplicate-job",
    [
      { id: "x", needs: [] },
      { id: "x", needs: [] },
    ],
  ],
  ["unknown-needs", [{ id: "x", needs: ["missing"] }]],
  ["self-needs", [{ id: "x", needs: ["x"] }]],
  [
    "needs-cycle",
    [
      { id: "x", needs: ["y"] },
      { id: "y", needs: ["x"] },
    ],
  ],
] as const)("rejects %s before any matrix work", async (code, jobs) => {
  expect((await Effect.runPromise(Effect.flip(validateJobGraph(jobs)))).code).toBe(code);
});

import { parseWorkflowLanguage } from "../src/language/parse.ts";
import { advancePlan, planWorkflow } from "../src/planning/plan.ts";
const present = <A>(value: A | undefined): A => {
  if (value === undefined) throw new Error("Expected fixture value");
  return value;
};
const parsed = (jobs: string) =>
  Effect.runPromise(parseWorkflowLanguage("ci.yml", `on: push\njobs:\n${jobs}`));
const simple = (extra = "") =>
  `  build:\n    runs-on: ubuntu-latest\n${extra}    steps:\n      - run: echo private-script\n`;
it("evaluates a false job condition before an invalid or explosive matrix", async () => {
  const workflow = await parsed(simple("    if: false\n    strategy:\n      matrix:\n        x: []\n"));
  const plan = await Effect.runPromise(planWorkflow(workflow));
  expect(plan.jobs[0]?.state).toBe("skipped");
  expect(plan.legs).toHaveLength(0);
});
it("retains needs-output conditions as deferred, then advances from supplied completions", async () => {
  const workflow = await parsed(
    `${simple(
      "    outputs:\n      publish: resolved-externally\n    strategy:\n      fail-fast: false\n      matrix:\n        node: [20, 22, 24]\n",
    )}  publish:\n    needs: build\n    if: needs.build.outputs.publish == 'yes'\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo publish\n  cleanup:\n    needs: build\n    if: always()\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo cleanup\n`,
  );
  const initial = await Effect.runPromise(planWorkflow(workflow, { maxParallel: 2 }));
  expect(initial.jobs.find((j) => j.id === "publish")?.state).toBe("deferred");
  expect(initial.legs.filter((l) => l.state === "ready")).toHaveLength(2);
  const partial = await Effect.runPromise(
    advancePlan(initial, {
      completions: initial.legs
        .filter((l) => l.jobId === "build" && l.state === "ready")
        .map((leg) => ({ legId: leg.id, outcome: "success" as const, outputs: { publish: "yes" } })),
    }),
  );
  const next = await Effect.runPromise(
    advancePlan(partial, {
      completions: partial.legs
        .filter((l) => l.jobId === "build" && l.state === "ready")
        .map((leg) => ({ legId: leg.id, outcome: "success" as const, outputs: { publish: "yes" } })),
    }),
  );
  expect(next.jobs.find((j) => j.id === "publish")?.state).toBe("expanded");
  expect(next.legs.filter((l) => l.jobId === "publish" || l.jobId === "cleanup").map((l) => l.state)).toEqual(
    ["ready", "ready"],
  );
});
it("keeps failure, skipped, cancelled, and continue-on-error outcomes distinct", async () => {
  const workflow = await parsed(
    `${simple("    continue-on-error: true\n")}  cleanup:\n    needs: build\n    if: always()\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo cleanup\n`,
  );
  const initial = await Effect.runPromise(planWorkflow(workflow));
  const next = await Effect.runPromise(
    advancePlan(initial, { completions: [{ legId: present(initial.legs[0]).id, outcome: "failure" }] }),
  );
  expect(next.legs[0]).toMatchObject({ outcome: "failure", conclusion: "success", state: "completed" });
  expect(next.legs.find((l) => l.jobId === "cleanup")?.state).toBe("ready");
});
it("requests fail-fast and timeout cancellation without fabricating completion", async () => {
  const workflow = await parsed(
    simple("    timeout-minutes: 1\n    strategy:\n      matrix:\n        x: [1, 2, 3]\n"),
  );
  const initial = await Effect.runPromise(planWorkflow(workflow));
  const next = await Effect.runPromise(
    advancePlan(initial, { completions: [{ legId: present(initial.legs[0]).id, outcome: "failure" }] }),
  );
  expect(next.legs.slice(1).map((l) => l.state)).toEqual(["cancel-requested", "cancel-requested"]);
  expect(next.legs[1]?.conclusion).toBeUndefined();
  const running = await Effect.runPromise(advancePlan(initial, { started: [present(initial.legs[0]).id] }));
  const timeout = await Effect.runPromise(
    advancePlan(running, { elapsedMs: { [present(initial.legs[0]).id]: 60000 } }),
  );
  expect(timeout.legs[0]).toMatchObject({ state: "cancel-requested", cancellation: "timeout" });
});
it("rejects known unsupported local/global intent before returning readiness", async () => {
  const workflow = await parsed(simple("    concurrency: private-group\n"));
  expect(await Effect.runPromise(Effect.flip(planWorkflow(workflow)))).toMatchObject({
    code: "unsupported-concurrency",
  });
});

it("ignores caller needs guesses and rejects completion before readiness", async () => {
  const workflow = await parsed(
    `${simple("    strategy:\n      matrix:\n        x: [1, 2]\n")}  after:
    needs: build
    if: needs.build.outputs.allow == 'yes'
    runs-on: ubuntu-latest
    steps:
      - run: echo after
`,
  );
  const initial = await Effect.runPromise(
    planWorkflow(workflow, {
      maxParallel: 1,
      facts: { needs: { build: { result: "success", outputs: { allow: "yes" } } } },
    }),
  );
  expect(initial.jobs.find((job) => job.id === "after")?.state).toBe("deferred");
  const queued = present(initial.legs.find((leg) => leg.state === "queued"));
  expect(
    await Effect.runPromise(
      Effect.flip(advancePlan(initial, { completions: [{ legId: queued.id, outcome: "success" }] })),
    ),
  ).toMatchObject({ code: "completion-invalid" });
  const ready = present(initial.legs.find((leg) => leg.state === "ready"));
  expect(
    await Effect.runPromise(
      Effect.flip(
        advancePlan(initial, {
          completions: [
            { legId: ready.id, outcome: "success" },
            { legId: ready.id, outcome: "success" },
          ],
        }),
      ),
    ),
  ).toMatchObject({ code: "completion-invalid" });
});

it("keeps running cancellation occupied until external completion", async () => {
  const workflow = await parsed(simple("    strategy:\n      matrix:\n        x: [1, 2]\n"));
  const initial = await Effect.runPromise(planWorkflow(workflow, { maxParallel: 2 }));
  const running = await Effect.runPromise(
    advancePlan(initial, { started: initial.legs.map((leg) => leg.id) }),
  );
  const failed = await Effect.runPromise(
    advancePlan(running, { completions: [{ legId: present(running.legs[0]).id, outcome: "failure" }] }),
  );
  expect(failed.legs[1]).toMatchObject({ state: "cancel-requested", active: true });
  const cancelled = await Effect.runPromise(
    advancePlan(failed, { completions: [{ legId: present(failed.legs[1]).id, outcome: "cancelled" }] }),
  );
  expect(cancelled.legs[1]).toMatchObject({ outcome: "cancelled", conclusion: "cancelled", active: false });
});
it("uses transitive failure ancestry and actual completion order for matrix job outputs", async () => {
  const workflow = await parsed(
    `${simple("    strategy:\n      fail-fast: false\n      matrix:\n        x: [1, 2]\n")}  middle:
    needs: build
    if: always()
    runs-on: ubuntu-latest
    steps:
      - run: echo middle
  after:
    needs: middle
    if: failure()
    runs-on: ubuntu-latest
    steps:
      - run: echo after
`,
  );
  const initial = await Effect.runPromise(planWorkflow(workflow));
  const middle = await Effect.runPromise(
    advancePlan(initial, {
      completions: [
        { legId: present(initial.legs[1]).id, outcome: "success" },
        { legId: present(initial.legs[0]).id, outcome: "failure" },
      ],
    }),
  );
  const after = await Effect.runPromise(
    advancePlan(middle, {
      completions: [
        { legId: present(middle.legs.find((leg) => leg.jobId === "middle")).id, outcome: "success" },
      ],
    }),
  );
  expect(after.legs.find((leg) => leg.jobId === "after")?.state).toBe("ready");
});

it("captures facts and limits and freezes returned planning views", async () => {
  const workflow = await parsed(
    `${simple()}  after:
    needs: build
    if: inputs.enabled
    runs-on: ubuntu-latest
    steps:
      - run: echo after
`,
  );
  const options = { maxParallel: 1, facts: { inputs: { enabled: true } } };
  const initial = await Effect.runPromise(planWorkflow(workflow, options));
  options.maxParallel = 4;
  options.facts.inputs.enabled = false;
  expect(Object.isFrozen(initial.legs)).toBe(true);
  expect(Object.isFrozen(initial.legs[0])).toBe(true);
  expect(Object.isFrozen(initial.legs[0]?.matrix)).toBe(true);
  const next = await Effect.runPromise(
    advancePlan(initial, { completions: [{ legId: present(initial.legs[0]).id, outcome: "success" }] }),
  );
  expect(next.legs.find((leg) => leg.jobId === "after")?.state).toBe("ready");
});

it("admits only declared job output IDs and defers missing resolved values", async () => {
  const workflow = await parsed(
    `${simple("    outputs:\n      allow: resolved-externally\n")}  after:
    needs: build
    if: needs.build.outputs.allow == 'yes'
    runs-on: ubuntu-latest
    steps:
      - run: echo after
`,
  );
  const initial = await Effect.runPromise(planWorkflow(workflow));
  const id = present(initial.legs[0]).id;
  expect(
    await Effect.runPromise(
      Effect.flip(
        advancePlan(initial, {
          completions: [{ legId: id, outcome: "success", outputs: { unknown: "yes" } }],
        }),
      ),
    ),
  ).toMatchObject({ code: "outputs-invalid" });
  const missing = await Effect.runPromise(
    advancePlan(initial, { completions: [{ legId: id, outcome: "success" }] }),
  );
  expect(missing.jobs.find((job) => job.id === "after")?.state).toBe("deferred");
  const resolved = await Effect.runPromise(
    advancePlan(missing, { resolvedOutputs: [{ legId: id, outputs: { allow: "yes" } }] }),
  );
  expect(resolved.legs.find((leg) => leg.jobId === "after")?.state).toBe("ready");
  const undeclared = await Effect.runPromise(planWorkflow(await parsed(simple())));
  expect(
    await Effect.runPromise(
      Effect.flip(
        advancePlan(undeclared, {
          completions: [
            { legId: present(undeclared.legs[0]).id, outcome: "success", outputs: { allow: "yes" } },
          ],
        }),
      ),
    ),
  ).toMatchObject({ code: "outputs-invalid" });
});

it("bounds total pre-exclusion workflow products and preserves the strategy source", async () => {
  const values = Array.from({ length: 129 }, (_, i) => i).join(", ");
  const first = simple(
    `    strategy:\n      matrix:\n        x: [${values}]\n        exclude:\n          - {}\n`,
  );
  const second = first.replace("  build:", "  other:");
  const failure = await Effect.runPromise(Effect.flip(planWorkflow(await parsed(first + second))));
  expect(failure).toMatchObject({ code: "matrix-limit", source: { file: "ci.yml" } });
});

it("retains known needs results and lazy output fields independently", async () => {
  const workflow = await parsed(`${simple("    outputs:\n      allow: resolved-externally\n")}  result_known:
    needs: build
    if: needs.build.result == 'success'
    runs-on: ubuntu-latest
    steps:
      - run: echo known
  output_unknown:
    needs: build
    if: needs.build.outputs.allow == 'yes'
    runs-on: ubuntu-latest
    steps:
      - run: echo deferred
  short_circuit:
    needs: build
    if: always() || needs.build.outputs.allow == 'yes'
    runs-on: ubuntu-latest
    steps:
      - run: echo known
`);
  const initial = await Effect.runPromise(planWorkflow(workflow));
  const next = await Effect.runPromise(
    advancePlan(initial, { completions: [{ legId: present(initial.legs[0]).id, outcome: "success" }] }),
  );
  expect(next.legs.find((leg) => leg.jobId === "result_known")?.state).toBe("ready");
  expect(next.legs.find((leg) => leg.jobId === "short_circuit")?.state).toBe("ready");
  expect(next.jobs.find((job) => job.id === "output_unknown")?.state).toBe("deferred");
});
