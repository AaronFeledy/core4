// @generated
// @source: docs/guides/corrupt-guide.mdx:7
// @variant:

import { test } from "bun:test";
import { Cause, Effect, Exit } from "effect";

import { withScenarioContext } from "@lando/core/testing";

test("corrupt-guide:unknown", async () => {
  const exit = await Effect.runPromiseExit(
    withScenarioContext({ guideId: "corrupt-guide", scenarioId: "unknown" }, () =>
      Effect.gen(function* () {
        // @source: docs/guides/corrupt-guide.mdx:12
        yield* Effect.succeed(undefined);
        throw new Error("seeded failure");
      }),
    ),
  );
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause), { cause: exit.cause });
});
