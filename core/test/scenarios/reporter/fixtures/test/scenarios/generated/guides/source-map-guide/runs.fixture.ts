// @generated
// @source: docs/guides/source-map-guide.mdx:7
// @scenario: runs
// @variant:

import { test } from "bun:test";
import { Effect } from "effect";

import { withScenarioContext } from "@lando/core/testing";

test("source-map-guide:runs", async () => {
  await Effect.runPromise(
    withScenarioContext({ guideId: "source-map-guide", scenarioId: "runs" }, () =>
      Effect.gen(function* () {
        // @source: docs/guides/source-map-guide.mdx:8
        // @step: run
        yield* Effect.succeed(undefined);
        // @source: docs/guides/source-map-guide.mdx:9
        throw new Error("seeded failure");
      }),
    ),
  );
});
