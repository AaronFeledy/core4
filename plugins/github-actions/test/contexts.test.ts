import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { admitSecrets, evaluateCondition, evaluateContextExpression } from "../src/contexts/index.ts";
const source = { file: ".github/workflows/test.yml", line: 8, column: 5 };
const success = { cancelled: false, previousSteps: [], ancestorJobs: [] } as const;
const condition = (text: string, facts = {}, status: Parameters<typeof evaluateCondition>[3] = success) =>
  Effect.runPromise(evaluateCondition(text, "step.if", facts, status, source));

test("missing property uses upstream null while unavailable root defers lazily", async () => {
  expect(await condition("env.missing == ''", { env: {} })).toEqual({ kind: "known", value: true });
  expect(await condition("runner.os == 'Linux'")).toEqual({
    kind: "deferred",
    reason: "context-unavailable",
  });
  expect(await condition("true || runner.os == 'Linux'")).toEqual({ kind: "known", value: true });
});
test("field eligibility rejects forbidden contexts even with supplied facts", async () => {
  const result = await Effect.runPromise(
    Effect.result(evaluateCondition("matrix.x == 1", "job.if", { matrix: { x: 1 } }, success, source)),
  );
  expect(Result.isFailure(result)).toBe(true);
  const matrix = await Effect.runPromise(
    Effect.result(evaluateContextExpression("matrix.x", "job.strategy", { matrix: { x: 1 } }, source)),
  );
  expect(Result.isFailure(matrix)).toBe(true);
});
test("invalid syntax remains an error despite unavailable roots or failed status", async () => {
  const result = await Effect.runPromise(
    Effect.result(
      evaluateCondition("runner.os == (", "step.if", {}, { ...success, cancelled: true }, source),
    ),
  );
  expect(Result.isFailure(result)).toBe(true);
});
test("implicit success uses AST calls and outcome remains separate from conclusion", async () => {
  const continued = {
    ...success,
    previousSteps: [{ outcome: "failure" as const, conclusion: "success" as const }],
  };
  expect(await condition("true", {}, continued)).toEqual({ kind: "known", value: true });
  const failed = {
    ...success,
    previousSteps: [{ outcome: "failure" as const, conclusion: "failure" as const }],
  };
  expect(await condition("'failure()' == 'failure()'", {}, failed)).toEqual({ kind: "known", value: false });
  expect(await condition("failure()", {}, failed)).toEqual({ kind: "known", value: true });
  expect(await condition("always()", {}, { ...success, cancelled: true })).toEqual({
    kind: "known",
    value: true,
  });
  expect(await condition("cancelled()", {}, { ...success, cancelled: true })).toEqual({
    kind: "known",
    value: true,
  });
  expect(
    await Effect.runPromise(
      evaluateCondition(
        "failure()",
        "job.if",
        {},
        { ...success, ancestorJobs: [{ result: "failure" }] },
        source,
      ),
    ),
  ).toEqual({ kind: "known", value: true });
});
test("secrets require explicit canonical registration and safe representations", async () => {
  const registered: string[] = [];
  const secrets = await Effect.runPromise(
    admitSecrets({ KEY: "PRIVATE_VALUE" }, (values) =>
      Effect.sync(() => {
        registered.push(...values);
      }),
    ),
  );
  expect(registered).toEqual(["PRIVATE_VALUE"]);
  for (const value of [JSON.stringify(secrets), String(secrets), Bun.inspect(secrets)])
    expect(value).not.toContain("PRIVATE_VALUE");
  const value = await Effect.runPromise(
    evaluateContextExpression("secrets.KEY", "step.run", { secrets }, source),
  );
  expect(value.kind).toBe("known");
  if (value.kind === "known") expect(value.value.coerceString()).toBe("PRIVATE_VALUE");
  const missing = await Effect.runPromise(
    evaluateContextExpression("secrets.GITHUB_TOKEN == ''", "step.run", { secrets }, source),
  );
  if (missing.kind === "known") expect(missing.value.coerceString()).toBe("true");
});
test("runner facts are explicit and context limits return fixed source errors", async () => {
  expect(await condition("runner.os == 'Linux'", { runner: { os: "Linux" } })).toEqual({
    kind: "known",
    value: true,
  });
  const result = await Effect.runPromise(
    Effect.result(
      evaluateContextExpression("env.X", "step.run", { env: { X: "PRIVATE".repeat(100000) } }, source),
    ),
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(JSON.stringify(result.failure)).not.toContain("PRIVATE");
});

test("context admission rejects accessors, cycles, wide arrays and UTF8 byte overflow", async () => {
  let invoked = false;
  const env = Object.defineProperty({}, "X", {
    enumerable: true,
    get() {
      invoked = true;
      return "x";
    },
  });
  for (const facts of [
    { env },
    { inputs: { big: new Array(60000).fill(1) } },
    { env: { X: "🥳".repeat(70000) } },
  ]) {
    const result = await Effect.runPromise(
      Effect.result(evaluateContextExpression("true", "step.run", facts, source)),
    );
    expect(Result.isFailure(result)).toBe(true);
  }
  expect(invoked).toBe(false);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const cyclic = await Effect.runPromise(
    Effect.result(evaluateContextExpression("true", "step.run", { github: cycle as never }, source)),
  );
  expect(Result.isFailure(cyclic)).toBe(true);
});
test("status snapshot arrays are bounded", async () => {
  const result = await Effect.runPromise(
    Effect.result(
      evaluateCondition(
        "success()",
        "step.if",
        {},
        { ...success, previousSteps: new Array(100000).fill({ outcome: "success", conclusion: "success" }) },
        source,
      ),
    ),
  );
  expect(Result.isFailure(result)).toBe(true);
});

test("hashFiles is available only in eligible fields and unavailable capture defers", async () => {
  expect(await condition("always() || hashFiles('**/*.ts') != ''")).toEqual({ kind: "known", value: true });
  expect(await condition("hashFiles('**/*.ts') != ''")).toEqual({
    kind: "deferred",
    reason: "context-unavailable",
  });
  const forbidden = await Effect.runPromise(
    Effect.result(evaluateContextExpression("hashFiles('**/*.ts')", "job.runs-on", {}, source)),
  );
  expect(Result.isFailure(forbidden)).toBe(true);
});

test("needs result remains known while undeclared output facts defer lazily", async () => {
  const facts = { needs: { build: { result: "success" as const } } };
  expect(
    await Effect.runPromise(
      evaluateCondition("needs.build.result == 'success'", "job.if", facts, success, source),
    ),
  ).toEqual({ kind: "known", value: true });
  expect(await condition("true || needs.build.outputs.foo == 'ready'", facts)).toEqual({
    kind: "known",
    value: true,
  });
  expect(await condition("needs.build.outputs.foo == 'ready'", facts)).toEqual({
    kind: "deferred",
    reason: "context-unavailable",
  });
  expect(await condition("needs.build.other == ''", facts)).toEqual({ kind: "known", value: true });
  expect(
    await condition("needs.build.outputs.foo == ''", {
      needs: { build: { result: "success", outputs: {} } },
    }),
  ).toEqual({ kind: "known", value: true });
  const malformed = await Effect.runPromise(
    Effect.result(evaluateCondition("needs.build.outputs.foo == (", "step.if", facts, success, source)),
  );
  expect(Result.isFailure(malformed)).toBe(true);
  if (Result.isFailure(malformed))
    expect(malformed.failure).toMatchObject({ code: "expression-syntax", source });
});
