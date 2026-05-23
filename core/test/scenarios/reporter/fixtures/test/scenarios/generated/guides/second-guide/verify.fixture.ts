// @generated
// @source: docs/guides/second-guide.mdx:7
// @scenario: verifies
// @variant:

import { test } from "bun:test";
import { Effect } from "effect";

import { withScenarioContext } from "@lando/core/testing";

test("second-guide:verifies", async () => {
  await Effect.runPromise(
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
});
