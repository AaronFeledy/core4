import { expect, it } from "bun:test";
import { data } from "@actions/expressions";
import { Effect, Result } from "effect";
import { createContext, evaluateCondition, evaluateContextExpression } from "../src/contexts/index.ts";
import { evaluateExpression } from "../src/language/expressions.ts";
import { parseWorkflowLanguage } from "../src/language/parse.ts";
import { advancePlan, planWorkflow } from "../src/planning/plan.ts";
const source = { file: "ci.yml", line: 4, column: 5 };
const success = { cancelled: false, previousSteps: [], ancestorJobs: [] } as const;
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const body = (extra = "", id = "build") =>
  `  ${id}:\n    runs-on: ubuntu-latest\n${extra}    steps:\n      - run: echo fixture\n`;
const parse = (jobs: string, top = "") =>
  run(parseWorkflowLanguage("ci.yml", `on: push\n${top}jobs:\n${jobs}`));
const plan = async (extra = "") => run(planWorkflow(await parse(body(extra))));
const firstId = (plan: { legs: readonly { id: string }[] }) => {
  const id = plan.legs[0]?.id;
  if (id === undefined) throw new Error("expected fixture leg");
  return id;
};
it.each(["failure", "cancelled", "skipped"] as const)(
  "fresh ordinary steps ignore %s ancestors",
  async (result) => {
    const snapshot = { ...success, ancestorJobs: [{ result }] };
    for (const [text, value] of [
      ["true", true],
      ["success()", true],
      ["failure()", false],
      ["cancelled()", false],
    ] as const)
      expect(await run(evaluateCondition(text, "step.if", {}, snapshot, source))).toEqual({
        kind: "known",
        value,
      });
    expect(await run(evaluateCondition("success()", "job.if", {}, snapshot, source))).toEqual({
      kind: "known",
      value: false,
    });
  },
);
it("cancelled job status overrides a previous step failure", async () => {
  const snapshot = {
    ...success,
    cancelled: true,
    previousSteps: [{ outcome: "failure" as const, conclusion: "failure" as const }],
  };
  expect(await run(evaluateCondition("failure()", "step.if", {}, snapshot, source))).toEqual({
    kind: "known",
    value: false,
  });
});
it.each([undefined, "null", "''", '""', "'   '", '"   "'])(
  "converted blank condition %s defaults to success",
  async (condition) => {
    const extra = condition === undefined ? "" : `    if: ${condition}\n`;
    const initial = await plan(extra);
    expect(initial.legs[0]?.state).toBe("ready");
    const workflow = await parse(body() + body(`    needs: build\n${extra}`, "after"));
    const waiting = await run(planWorkflow(workflow));
    const failed = await run(
      advancePlan(waiting, { completions: [{ legId: firstId(waiting), outcome: "failure" }] }),
    );
    expect(failed.jobs.find((job) => job.id === "after")?.state).toBe("skipped");
  },
);
it("false conditions stay false and malformed conditions fail conversion", async () => {
  expect((await plan("    if: false\n")).jobs[0]?.state).toBe("skipped");
  expect(
    (
      await run(
        Effect.result(parseWorkflowLanguage("ci.yml", `on: push\njobs:\n${body("    if: success(\n")}`)),
      )
    )._tag,
  ).toBe("Failure");
});
it.each(["always()", "!cancelled()", "success()"])(
  "running workflow cancellation reevaluates %s and keeps active occupancy",
  async (condition) => {
    const initial = await plan(`    if: \${{ ${condition} }}\n`);
    const running = await run(advancePlan(initial, { started: [firstId(initial)] }));
    const cancelled = await run(advancePlan(running, { cancelled: true }));
    expect(cancelled.legs[0]).toMatchObject({
      state: condition === "always()" ? "running" : "cancel-requested",
      active: true,
    });
    expect(running.legs[0]?.state).toBe("running");
    const done = await run(
      advancePlan(cancelled, { completions: [{ legId: firstId(initial), outcome: "cancelled" }] }),
    );
    expect(done.legs[0]?.active).toBe(false);
  },
);
it("default running condition cancels and always keeps waiting legs cancellation unchanged", async () => {
  const initial = await plan();
  const running = await run(advancePlan(initial, { started: [firstId(initial)] }));
  expect((await run(advancePlan(running, { cancelled: true }))).legs[0]).toMatchObject({
    state: "cancel-requested",
    active: true,
    cancellation: "workflow",
  });
  const queued = await run(
    planWorkflow(await parse(body("    if: always()\n    strategy:\n      matrix:\n        x: [1, 2]\n")), {
      maxParallel: 1,
    }),
  );
  const active = await run(advancePlan(queued, { started: [firstId(queued)] }));
  const cancelled = await run(advancePlan(active, { cancelled: true }));
  expect(cancelled.legs.map((leg) => leg.state)).toEqual(["running", "cancel-requested"]);
});
it("independent timeout and fail-fast take precedence over true or deferred cancellation conditions", async () => {
  const initial = await plan("    if: always()\n    timeout-minutes: 1\n");
  const running = await run(advancePlan(initial, { started: [firstId(initial)] }));
  expect(
    (await run(advancePlan(running, { cancelled: true, elapsedMs: { [firstId(initial)]: 60000 } }))).legs[0],
  ).toMatchObject({ cancellation: "timeout", active: true });
  for (const condition of ["always()", "!cancelled() || vars.missing"]) {
    const initial = await plan(
      `    if: \${{ ${condition} }}\n    strategy:\n      matrix:\n        x: [1, 2]\n`,
    );
    const running = await run(advancePlan(initial, { started: initial.legs.map((leg) => leg.id) }));
    const failed = await run(
      advancePlan(running, {
        cancelled: true,
        completions: [{ legId: firstId(initial), outcome: "failure" }],
      }),
    );
    expect(failed.legs[1]).toMatchObject({
      state: "cancel-requested",
      cancellation: "fail-fast",
      active: true,
    });
  }
});
it("deferred running cancellation is a sourced typed error and leaves the old plan intact", async () => {
  const initial = await plan("    if: ${{ !cancelled() || vars.missing }}\n");
  const running = await run(advancePlan(initial, { started: [firstId(initial)] }));
  const result = await run(Effect.result(advancePlan(running, { cancelled: true })));
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      _tag: "LanguageError",
      code: "context-unavailable",
      source: { file: "ci.yml", line: 5 },
    });
  expect(running.legs[0]).toMatchObject({ state: "running", active: true });
});
it("captures converted conditions privately before caller mutation and deferred expansion", async () => {
  const workflow = await parse(
    body("    if: always()\n") + body("    needs: build\n    if: needs.build.result == 'success'\n", "after"),
  );
  const initial = await run(planWorkflow(workflow));
  expect(initial.jobs.find((job) => job.id === "after")?.state).toBe("deferred");
  const falseCondition = (await parse(body("    if: false\n"))).workflow.jobs[0]?.if;
  if (falseCondition === undefined) throw new Error("expected converted false condition");
  for (const job of workflow.workflow.jobs) job.if = falseCondition;
  const running = await run(advancePlan(initial, { started: [firstId(initial)] }));
  expect((await run(advancePlan(running, { cancelled: true }))).legs[0]?.state).toBe("running");
  expect(JSON.stringify(initial.jobs)).not.toContain("always");
  const next = await run(
    advancePlan(initial, { completions: [{ legId: firstId(initial), outcome: "success" }] }),
  );
  expect(next.legs.find((leg) => leg.jobId === "after")?.state).toBe("ready");
});
it.each(["workflow", "job"])("rejects scalar write-all OIDC intent at %s scope", async (scope) => {
  const workflow = await parse(
    body(scope === "job" ? "    permissions: write-all\n" : "    permissions: {}\n"),
    scope === "workflow" ? "permissions: write-all\n" : "",
  );
  expect(await run(Effect.flip(planWorkflow(workflow)))).toMatchObject({
    code: "unsupported-oidc",
    source: { file: "ci.yml" },
  });
});
it.each(["read-all", "{}", "{id-token: none}", "{contents: read}"])(
  "accepts permission control %s",
  async (permission) => {
    const workflow = await parse(body(`    permissions: ${permission}\n`), `permissions: ${permission}\n`);
    expect((await run(planWorkflow(workflow))).legs[0]?.state).toBe("ready");
  },
);
it.each(["1e999", "-1e999", "NaN", "fromJSON('1e999')", "fromJSON('-1e999')"])(
  "rejects nonfinite field %s before readiness",
  async (expression) => {
    for (const field of ["timeout-minutes", "continue-on-error"])
      expect(
        await run(Effect.flip(planWorkflow(await parse(body(`    ${field}: \${{ ${expression} }}\n`))))),
      ).toMatchObject({ code: "job-field-invalid" });
    for (const field of ["max-parallel", "fail-fast"])
      expect(
        await run(
          Effect.flip(
            planWorkflow(await parse(body(`    strategy:\n      ${field}: \${{ ${expression} }}\n`))),
          ),
        ),
      ).toMatchObject({ code: "strategy-invalid" });
  },
);
it.each(["1e999", "-1e999"])(
  "rejects nested nonfinite matrix %s without JSON normalization",
  async (number) => {
    const initial = await parse(body(`    strategy:\n      matrix: \${{ fromJSON('{"x":[${number}]}') }}\n`));
    expect(await run(Effect.flip(planWorkflow(initial)))).toMatchObject({ code: "matrix-input-limit" });
  },
);
it("keeps finite and null defaults plus pure nonfinite expression semantics", async () => {
  expect(
    (await plan("    timeout-minutes: ${{ null }}\n    continue-on-error: ${{ null }}\n")).legs[0],
  ).toMatchObject({ timeoutMs: 21600000, continueOnError: false });
  expect((await plan("    timeout-minutes: 2\n    continue-on-error: true\n")).legs[0]).toMatchObject({
    timeoutMs: 120000,
    continueOnError: true,
  });
  for (const [text, value] of [
    ["1e999", Number.POSITIVE_INFINITY],
    ["-1e999", Number.NEGATIVE_INFINITY],
    ["NaN", Number.NaN],
    ["fromJSON('1e999')", Number.POSITIVE_INFINITY],
  ] as const) {
    const result = await run(evaluateExpression(text, new data.Dictionary(), source));
    expect(result).toBeInstanceOf(data.NumberData);
    if (result instanceof data.NumberData) expect(result.value).toBe(value);
  }
});
it("incomplete needs enumeration defers while result access and short circuits stay known", async () => {
  const facts = { needs: { build: { result: "success" as const } } };
  for (const text of [
    "toJSON(needs.build)",
    "toJSON(needs)",
    "needs.build.*",
    "needs.*.*",
    "toJSON(needs.*)",
  ])
    expect(await run(evaluateContextExpression(text, "job.if", facts, source, success))).toEqual({
      kind: "deferred",
      reason: "context-unavailable",
    });
  for (const text of [
    "needs.build.result == 'success'",
    "needs.build.other == null",
    "contains(needs.*.result, 'success')",
    "false && toJSON(needs)",
  ])
    expect((await run(evaluateContextExpression(text, "job.if", facts, source, success))).kind).toBe("known");
  expect(
    (
      await run(
        evaluateContextExpression(
          "toJSON(needs)",
          "job.if",
          { needs: { build: { result: "success", outputs: {} } } },
          source,
          success,
        ),
      )
    ).kind,
  ).toBe("known");
});
it("partial dictionaries still charge known descendant keys, bytes, depth, and repeated visits", async () => {
  const context = createContext("job.if", { needs: { build: { result: "success" } } });
  const needs = context.get("needs");
  if (!(needs instanceof data.Dictionary)) throw new Error("expected needs");
  const partial = needs.get("build");
  if (partial === undefined) throw new Error("expected partial");
  const repeated = new data.Dictionary({ key: "one", value: partial }, { key: "two", value: partial });
  for (const [value, limits] of [
    [partial, { valueBytes: 12 }],
    [partial, { valueDepth: 1 }],
    [repeated, { valueNodes: 4 }],
  ] as const)
    expect(
      await run(
        Effect.flip(
          evaluateExpression("true", new data.Dictionary({ key: "needs", value }), source, { limits }),
        ),
      ),
    ).toMatchObject({ code: "expression-limit" });
});
it("enumerated needs conditions defer until output resolution, and whole-object fields defer without defects", async () => {
  for (const field of ["condition", "runner", "strategy"] as const) {
    const extra =
      field === "condition"
        ? "    if: contains(toJSON(needs.build), 'yes')\n"
        : field === "runner"
          ? "    runs-on: ${{ needs.build }}\n"
          : "    strategy: ${{ needs.build }}\n";
    const after =
      field === "runner"
        ? body("    needs: build\n", "after").replace("    runs-on: ubuntu-latest\n", extra)
        : body(`    needs: build\n${extra}`, "after");
    const initial = await run(
      planWorkflow(await parse(body("    outputs:\n      allow: resolved-externally\n") + after)),
    );
    const missing = await run(
      advancePlan(initial, { completions: [{ legId: firstId(initial), outcome: "success" }] }),
    );
    expect(missing.jobs.find((job) => job.id === "after")?.state).toBe("deferred");
    if (field === "condition") {
      const resolved = await run(
        advancePlan(missing, { resolvedOutputs: [{ legId: firstId(initial), outputs: { allow: "yes" } }] }),
      );
      expect(resolved.legs.find((leg) => leg.jobId === "after")?.state).toBe("ready");
    }
  }
});

it("an always-admitted rescue job starts with successful ordinary step status after failed needs", async () => {
  const workflow = await parse(body() + body("    needs: build\n    if: always()\n", "rescue"));
  const initial = await run(planWorkflow(workflow));
  const advanced = await run(
    advancePlan(initial, { completions: [{ legId: firstId(initial), outcome: "failure" }] }),
  );
  expect(advanced.legs.find((leg) => leg.jobId === "rescue")?.state).toBe("ready");
  const ancestor = advanced.legs.find((leg) => leg.jobId === "build")?.conclusion;
  if (ancestor === undefined) throw new Error("expected completed ancestor");
  const snapshot = { ...success, ancestorJobs: [{ result: ancestor }] };
  for (const [text, value] of [
    ["true", true],
    ["success()", true],
    ["failure()", false],
    ["cancelled()", false],
  ] as const)
    expect(await run(evaluateCondition(text, "step.if", {}, snapshot, source))).toEqual({
      kind: "known",
      value,
    });
});
