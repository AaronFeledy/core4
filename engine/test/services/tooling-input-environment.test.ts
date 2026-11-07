import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  ToolingBooleanEnvironment,
  environmentForRedaction,
} from "../../src/services/tooling-input-environment.ts";

test("omits only explicit canonical boolean bindings after merging heuristic sources", async () => {
  // Given
  const inherited = { LANDO_FLAG_TOKEN: "old-secret" };
  const explicit = { LANDO_FLAG_TOKEN: "true", PASSWORD: "true" };
  // When
  const environment = await Effect.runPromise(
    environmentForRedaction(inherited, explicit).pipe(
      Effect.provideService(ToolingBooleanEnvironment, { LANDO_FLAG_TOKEN: true }),
    ),
  );
  // Then
  expect(environment).toEqual({ PASSWORD: "true" });
  expect(explicit).toEqual({ LANDO_FLAG_TOKEN: "true", PASSWORD: "true" });
});

test.each([
  { inherited: { LANDO_FLAG_TOKEN: "true" }, explicit: undefined, expected: "true" },
  { inherited: {}, explicit: { LANDO_FLAG_TOKEN: "changed-secret" }, expected: "changed-secret" },
])(
  "retains bindings without matching explicit boolean provenance: %j",
  async ({ inherited, explicit, expected }) => {
    // Given / When
    const environment = await Effect.runPromise(
      environmentForRedaction(inherited, explicit).pipe(
        Effect.provideService(ToolingBooleanEnvironment, { LANDO_FLAG_TOKEN: true }),
      ),
    );
    // Then
    expect(environment).toEqual({ LANDO_FLAG_TOKEN: expected });
  },
);

test("does not exempt boolean-looking strings outside tooling's scope", async () => {
  // Given / When
  const environment = await Effect.runPromise(environmentForRedaction({}, { LANDO_FLAG_TOKEN: "true" }));
  // Then
  expect(environment).toEqual({ LANDO_FLAG_TOKEN: "true" });
});
