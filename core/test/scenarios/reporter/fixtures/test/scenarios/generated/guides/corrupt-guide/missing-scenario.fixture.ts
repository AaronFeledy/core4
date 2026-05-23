// @generated
// @source: docs/guides/corrupt-guide.mdx:7
// @variant:

import { test } from "bun:test";
import { Effect } from "effect";

import { withScenarioContext } from "@lando/core/testing";

test("corrupt-guide:unknown", async () => {
  await Effect.runPromise(
    withScenarioContext({ guideId: "corrupt-guide", scenarioId: "unknown" }, () =>
      Effect.gen(function* () {
        // @source: docs/guides/corrupt-guide.mdx:12
        yield* Effect.succeed(undefined);
        throw new Error("seeded failure");
      }),
    ),
  );
});
