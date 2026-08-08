import { expect, test } from "bun:test";

import { Effect } from "effect";

import { ServiceName } from "@lando/sdk/schema";

import { validateServiceDependencies } from "@lando/engine/services/dependency-validation";

test("treats __proto__ as missing unless it is an own service property", async () => {
  // Given
  const services = {
    web: {
      dependsOn: [
        { service: ServiceName.make("__proto__"), condition: "service_started" as const, required: true },
      ],
    },
  };

  // When
  const error = await Effect.runPromise(Effect.flip(validateServiceDependencies("/app", services)));

  // Then
  expect(error).toMatchObject({ _tag: "LandofileValidationError" });
  expect(error.message).toContain("missing service __proto__");
});
