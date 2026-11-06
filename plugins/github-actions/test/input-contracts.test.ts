import { expect, it } from "bun:test";
import { Cause, Effect, Exit, Result, Schema } from "effect";
import { ListWorkflowsOptions, decodeListWorkflowsOptions } from "../src/schema.ts";

for (const workflow of [
  undefined,
  ".github/workflows/release checks.yml",
  ".github/workflows/-ci.yml",
  ".github/workflows/構築.yaml",
]) {
  it(`accepts a direct workflow selection when ${workflow} is supplied`, async () => {
    const input = { root: "/repo", ...(workflow === undefined ? {} : { workflow }) };
    const result = await Effect.runPromise(decodeListWorkflowsOptions(input));
    expect(result).toEqual(input);
    expect(Schema.decodeUnknownSync(ListWorkflowsOptions)(input)).toEqual(input);
  });
}

for (const [input, reason, issue] of [
  [{}, "root-required", { path: "root", rule: "required" }],
  [{ root: 5 }, "invalid-root", { path: "root", rule: "type" }],
  [{ root: "PRIVATE_SENTINEL\n" }, "invalid-root", { path: "root", rule: "path" }],
  [{ root: "/repo", workflow: 5 }, "invalid-workflow", { path: "workflow", rule: "type" }],
  [{ root: "/repo", workflow: "PRIVATE_SENTINEL" }, "invalid-workflow", { path: "workflow", rule: "path" }],
  [
    { root: "/repo", PRIVATE_SENTINEL: "PRIVATE_VALUE" },
    "unknown-input",
    { path: "input", rule: "unknown-field" },
  ],
  [null, "invalid-options", { path: "input", rule: "type" }],
] as const) {
  it(`identifies the safe ${issue.path}/${issue.rule} issue when input is rejected`, async () => {
    const result = await Effect.runPromise(Effect.result(decodeListWorkflowsOptions(input)));
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason, issue } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });
}
for (const workflow of [
  "../ci.yml",
  ".github/workflows/../ci.yml",
  ".github/workflows/nested/ci.yml",
  ".github/workflows/..\\ci.yml",
  ".github/workflows/ci.yml\n",
  ".github/workflows/c\0i.yml",
  "/tmp/ci.yml",
  ".github/workflows/ci.txt",
  "*.yml",
]) {
  it("rejects unsafe or unsupported selectors without retaining their value", async () => {
    const input = { root: "/repo", workflow };
    const result = await Effect.runPromise(Effect.result(decodeListWorkflowsOptions(input)));
    expect(Result.isFailure(result)).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(ListWorkflowsOptions)(input, { onExcessProperty: "error" }),
      ),
    ).toBe(true);
  });
}
for (const input of [
  null,
  {},
  { root: "" },
  { root: " " },
  { root: "/repo\n" },
  { root: 5 },
  { root: "/repo", token: "PRIVATE_SENTINEL" },
  { root: "/repo", workflow: 5 },
  { root: "/repo", event: "push" },
]) {
  it("agrees with the exported schema when input is rejected", async () => {
    const exit = await Effect.runPromiseExit(decodeListWorkflowsOptions(input));
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(ListWorkflowsOptions)(input, { onExcessProperty: "error" }),
      ),
    ).toBe(true);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).not.toContain("PRIVATE_SENTINEL");
      expect(Cause.pretty(exit.cause)).toContain("GithubActionsWorkflowError");
    }
  });
}
