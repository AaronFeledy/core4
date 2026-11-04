import { expect, it } from "bun:test";
import { Effect } from "effect";
import { expandMatrix } from "../src/planning/matrix.ts";

const run = (matrix: unknown, options = {}) => Effect.runPromise(expandMatrix(matrix, options));
it("forms ordered products, excludes partial matches, and augments originals in include order", async () => {
  expect(
    await run({
      os: ["linux", "mac"],
      node: [20, 24],
      exclude: [{ os: "mac", node: 20 }],
      include: [
        { color: "green" },
        { os: "linux", color: "pink" },
        { os: "windows", node: 24 },
        { os: "windows", node: 24, extra: true },
      ],
    }),
  ).toEqual([
    { os: "linux", node: 20, color: "pink" },
    { os: "linux", node: 24, color: "pink" },
    { os: "mac", node: 24, color: "green" },
    { os: "windows", node: 24 },
    { os: "windows", node: 24, extra: true },
  ]);
});
it("supports include-only matrices without merging standalone include entries", async () => {
  expect(await run({ include: [{ os: "linux" }, { os: "linux", node: 24 }] })).toEqual([
    { os: "linux" },
    { os: "linux", node: 24 },
  ]);
});
it("rejects invalid filters and pre-product overflow even when exclusion would reduce it", async () => {
  for (const matrix of [
    { x: [1], exclude: [{ unknown: 1 }] },
    { x: [] },
    { x: Array.from({ length: 257 }, (_, i) => i), exclude: [{}] },
    { x: [1], include: [null] },
  ]) {
    const error = await Effect.runPromise(Effect.flip(expandMatrix(matrix)));
    expect(error._tag).toBe("PlanningError");
  }
});
it("bounds intermediate include work and honors narrower final budgets", async () => {
  expect(await run({ x: [1, 2] }, { maxJobs: 2 })).toHaveLength(2);
  expect((await Effect.runPromise(Effect.flip(expandMatrix({ x: [1, 2, 3] }, { maxJobs: 2 })))).code).toBe(
    "matrix-limit",
  );
});
it("rejects accessors and nonplain objects without invoking authored code", async () => {
  let calls = 0;
  const hostile = {
    get x() {
      calls++;
      return [1];
    },
  };
  for (const value of [hostile, new Map(), Object.create({ x: [1] })])
    expect((await Effect.runPromise(Effect.flip(expandMatrix(value))))._tag).toBe("PlanningError");
  expect(calls).toBe(0);
});
it("bounds aggregate text and safely preserves prototype-shaped authored keys", async () => {
  const error = await Effect.runPromise(Effect.flip(expandMatrix({ x: Array(32).fill("x".repeat(16384)) })));
  expect(error.code).toBe("matrix-input-limit");
  const result = await run(JSON.parse('{"x":[1],"include":[{"__proto__":{"polluted":true}}]}'));
  const row = result[0];
  if (row === undefined) throw new Error("Expected matrix row");
  expect(Object.hasOwn(row, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
});

it("charges recursive comparisons to the finite work budget", async () => {
  const value = () => Object.fromEntries(Array.from({ length: 90 }, (_, i) => [String(i), i]));
  const input = {
    x: Array.from({ length: 32 }, value),
    include: Array.from({ length: 32 }, () => ({ x: value() })),
  };
  expect((await Effect.runPromise(Effect.flip(expandMatrix(input)))).code).toBe("matrix-work-limit");
});
