// @generated
// @scenario: broken-source
// @variant:

import { test } from "bun:test";
import { Effect } from "effect";

import { withScenarioContext } from "@lando/core/testing";

test("corrupt-guide:broken-source", async () => {
  await Effect.runPromise(
    withScenarioContext({ guideId: "corrupt-guide", scenarioId: "broken-source" }, () =>
      Effect.gen(function* () {
        yield* Effect.succeed(undefined);
        throw new Error("seeded failure");
      }),
    ),
  );
});
