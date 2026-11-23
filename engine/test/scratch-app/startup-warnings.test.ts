import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import { ScratchAppService } from "@lando/sdk/services";
import { Effect, Exit, Schema } from "effect";
import { withStartupFixture } from "./startup-fixture.ts";

test("scratch start reports the low-port warning before it applies, even when apply fails", async () => {
  await withStartupFixture(
    {
      apply: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "apply",
            message: "Runtime is powered off",
            remediation: "Prepare the runtime before applying the plan.",
          }),
        ),
    },
    async (fixture) => {
      // When a scratch app whose web service listens on port 80 as a named user starts.
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(ScratchAppService, (scratch) =>
          scratch.acquire({ source: { kind: "fork" }, isolate: "none", detached: true }),
        ).pipe(Effect.scoped, Effect.provide(fixture.layer)),
      );
      // Then the start fails but its warning was already printed.
      expect(Exit.isFailure(exit)).toBe(true);
      const warnings = fixture.events.flatMap((event) =>
        Schema.is(MessageWarnEvent)(event) && event.body.includes("low-port") ? [event.body] : [],
      );
      expect(warnings).toEqual([expect.stringContaining("declares container port 80 as www-data")]);
      expect(fixture.applied).toEqual([]);
    },
    { web: { user: "www-data", endpoints: [{ kind: "internal", protocol: "http", port: 80 }] } },
  );
});
