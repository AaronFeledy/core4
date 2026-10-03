import { expect, test } from "bun:test";

import { Effect } from "effect";

import { ServiceName } from "@lando/sdk/schema";

import { validateServiceDependencies } from "../../src/services/dependency-validation.ts";

test("reports the first dependency cycle with authored conditions and its closing edge", async () => {
  // Given: a leading service enters a cycle that starts at db, not web.
  const services = {
    web: { dependsOn: [{ service: "db", condition: "service_started", required: true }] },
    db: { dependsOn: [{ service: "cache", condition: "service_completed_successfully", required: false }] },
    cache: { dependsOn: [{ service: "db", condition: "service_started", required: false }] },
  };
  // When
  const error = await Effect.runPromise(Effect.flip(validateServiceDependencies("/app", services)));
  // Then
  expect(error).toMatchObject({
    _tag: "LandofileValidationError",
    message:
      "Dependency cycle detected: db --[service_completed_successfully]--> cache --[service_started]--> db. Remove or redirect one dependency edge; required: false does not break a dependency cycle.",
    file: "/app/.lando.yml",
    issues: ["services.cache.dependsOn"],
  });
});

test("reports a self dependency as a one-edge cycle", async () => {
  // Given
  const services = { web: { dependsOn: [{ service: "web", condition: "service_started", required: true }] } };
  // When
  const error = await Effect.runPromise(Effect.flip(validateServiceDependencies("/app", services)));
  // Then
  expect(error).toMatchObject({
    message:
      "Dependency cycle detected: web --[service_started]--> web. Remove or redirect one dependency edge; required: false does not break a dependency cycle.",
    issues: ["services.web.dependsOn"],
  });
});

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
