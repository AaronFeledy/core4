import { expect, test } from "bun:test";
import { ConfigTranslateSourceId, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { assessTranslateExpectations } from "../../src/planner/home-expectations.ts";

test("reports an unavailable catalog instead of loading bundled plugins when no registry is supplied", async () => {
  // Given a home expectation and no plugin registry in context
  const expectation = {
    _tag: "PersistedHome" as const,
    sourceId: ConfigTranslateSourceId.make(".lando.yml"),
    keyPath: ["services", "web"],
    service: ServiceName.make("web"),
  };
  // When
  const diagnostics = await Effect.runPromise(
    assessTranslateExpectations([expectation], { services: { web: { type: "node:22" } } }),
  );
  // Then
  expect(diagnostics.map(({ kind, message }) => [kind, message])).toEqual([
    [
      "needs-review",
      "Lando 3 kept this service's home; Lando 4 can't confirm it will keep it automatically (the service catalog is unavailable).",
    ],
  ]);
});
