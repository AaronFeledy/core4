// @generated
// @source: docs/guides/second-guide.mdx:7
// @scenario: verifies
// @variant:

import { test } from "bun:test";
import { Cause, Effect, Exit } from "effect";

import { withScenarioContext } from "@lando/core/testing";

test("second-guide:verifies", async () => {
  const exit = await Effect.runPromiseExit(
    withScenarioContext({ guideId: "second-guide", scenarioId: "verifies" }, () =>
      Effect.gen(function* () {
        // @source: docs/guides/second-guide.mdx:10
        // @step: verify
        yield* Effect.succeed(undefined);
        // @source: docs/guides/second-guide.mdx:11
        throw new Error("seeded failure");
      }),
    ),
  );
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause), { cause: exit.cause });
});
