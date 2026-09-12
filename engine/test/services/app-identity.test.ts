import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { resolveAppIdentity } from "../../src/planner/app-identity.ts";

test("rejects ownership when the app root cannot be canonicalized", async () => {
  const missingRoot = join(tmpdir(), `lando-missing-${randomUUID()}`);
  const result = await Effect.runPromiseExit(resolveAppIdentity(missingRoot));
  expect(Exit.isFailure(result)).toBe(true);
});
