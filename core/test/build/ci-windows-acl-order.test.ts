import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("generates preload dependencies before native Windows ACL tests on a clean checkout", async () => {
  // Given the generated CI workflow used by a fresh Windows runner
  const workflow = await Bun.file(resolve(import.meta.dirname, "../../../.github/workflows/ci.yml")).text();
  const job = workflow.match(/^ {2}static-checks-platform:\n[\s\S]*?(?=^ {2}[\w-]+:)/m)?.[0];
  if (job === undefined) throw new Error("Missing static-checks-platform job");

  // When its source-generation and native ACL execution steps are located
  const generation = job.indexOf("run: bun run codegen:check");
  const acl = job.indexOf("run: bun test state-store/test/state-store/private-file-access.test.ts");

  // Then the test preload can import generated bundled plugins before any test runs
  expect(generation).toBeGreaterThanOrEqual(0);
  expect(acl).toBeGreaterThan(generation);
});
