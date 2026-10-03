// @generated
// @source: docs/guides/source-map-guide.mdx:7
// @scenario: runs
// @variant:

import { test } from "bun:test";
import { Cause, Effect, Exit } from "effect";

import { withScenarioContext } from "@lando/core/testing";

test("source-map-guide:runs", async () => {
  const exit = await Effect.runPromiseExit(
    withScenarioContext({ guideId: "source-map-guide", scenarioId: "runs" }, () =>
      Effect.gen(function* () {
        // @source: docs/guides/source-map-guide.mdx:8
        // @step: run
        yield* Effect.succeed(undefined);
        // @source: docs/guides/source-map-guide.mdx:9
        throw new Error("seeded failure");
      }).pipe(Effect.ensuring(Effect.die(new Error("cleanup defect")))),
    ),
  );
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause), { cause: exit.cause });
});
