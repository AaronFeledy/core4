import { expect, test } from "bun:test";
import { Effect } from "effect";

import { withScenarioContext } from "@lando/core/testing";

test("uses the test runtime provider for exec when a guide uses the scenario harness", async () => {
  const result = await Effect.runPromise(
    withScenarioContext({ guideId: "exec", scenarioId: "test-provider-exec" }, (context) =>
      Effect.gen(function* () {
        // Given: a provider:test guide fixture whose lifecycle start is handled by the scenario harness.
        yield* context.fixtures.use("exec-demo");
        yield* context.runCli(["start"]);

        // When: the same guide invokes the real app:exec CLI path.
        return yield* context.runCli(["exec", "--", "echo", "hello"]);
      }),
    ),
  );

  // Then: exec is dispatched through TestRuntimeProvider rather than a live provider registry.
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("echo hello\n");
  expect(result.stderr).toBe("");
});
