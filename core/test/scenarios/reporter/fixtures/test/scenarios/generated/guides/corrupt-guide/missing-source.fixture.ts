// @generated
// @scenario: broken-source
// @variant:

import { test } from "bun:test";
import { Cause, Effect, Exit } from "effect";

import { withScenarioContext } from "@lando/core/testing";

test("corrupt-guide:broken-source", async () => {
  const exit = await Effect.runPromiseExit(
    withScenarioContext({ guideId: "corrupt-guide", scenarioId: "broken-source" }, () =>
      Effect.gen(function* () {
        yield* Effect.succeed(undefined);
        throw new Error("seeded failure");
      }),
    ),
  );
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause), { cause: exit.cause });
});
