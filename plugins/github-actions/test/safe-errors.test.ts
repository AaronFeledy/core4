import { expect, it } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { GithubActionsWorkflowError, workflowError } from "../src/errors.ts";
import { decodeListWorkflowsOptions } from "../src/schema.ts";

it("drops submitted values and schema issues when options fail", async () => {
  const result = await Effect.runPromise(
    Effect.result(decodeListWorkflowsOptions({ root: "PRIVATE_SENTINEL\0", extra: "PRIVATE_SENTINEL" })),
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    for (const rendered of [
      JSON.stringify(result.failure),
      String(result.failure),
      Bun.inspect(result.failure),
    ])
      expect(rendered).not.toContain("PRIVATE_SENTINEL");
    expect(result.failure.cause).toBeUndefined();
    expect(result.failure.reason).toBe("unknown-input");
    expect(result.failure.issue).toEqual({ path: "input", rule: "unknown-field" });
  }
});

it("round-trips a safe concrete acquisition error", () => {
  const error = workflowError("inventory-limit");
  const encoded = Schema.encodeSync(GithubActionsWorkflowError)(error);
  expect(Schema.decodeUnknownSync(GithubActionsWorkflowError)(encoded)).toMatchObject({
    _tag: "GithubActionsWorkflowError",
    reason: "inventory-limit",
  });
});
