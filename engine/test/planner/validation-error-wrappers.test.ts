import { expect, test } from "bun:test";
import { LandofileValidationError } from "@lando/sdk/errors";
import { appFeatureError, servicePlanError } from "../../src/planner/service-types.ts";

const wrappers = [
  {
    name: "servicePlanError",
    wrap: (cause: unknown) => servicePlanError("/app", "web", cause),
    path: ["services", "web"],
    fallback: "Invalid service web.",
    remediation: "Correct the configuration of service web.",
  },
  {
    name: "appFeatureError",
    wrap: (cause: unknown) => appFeatureError("/app", cause),
    path: ["appFeatures"],
    fallback: "Invalid app-feature composition.",
    remediation: "Correct the app-feature configuration or remove the failing feature.",
  },
];

test.each(wrappers)("$name preserves structured validation errors by identity", ({ wrap }) => {
  // Given
  const cause = new LandofileValidationError({
    file: "/app/.lando.local.yml",
    message: "Invalid local port.",
    remediation: "Fix the local port.",
    issues: [
      {
        path: ["services", "web", "port"],
        message: "Expected number.",
        source: {
          file: "/app/.lando.local.yml",
          layer: "local",
          path: ["services", "web", "port"],
        },
      },
    ],
  });
  // When
  const result = wrap(cause);
  // Then
  expect(result).toBe(cause);
  expect(result.file).toBe("/app/.lando.local.yml");
  expect(result.remediation).toBe("Fix the local port.");
  expect(result.issues).toEqual(cause.issues);
  expect(result.issues[0]?.source).toBe(cause.issues[0]?.source);
});

test.each(wrappers)("$name wraps an unstructured Error", ({ wrap, path, remediation }) => {
  // Given
  const cause = new Error("Plugin configuration failed.");
  // When
  const result = wrap(cause);
  // Then
  expect(result).toBeInstanceOf(LandofileValidationError);
  expect(result.file).toBe("/app/.lando.yml");
  expect(result.message).toBe(cause.message);
  expect(result.remediation).toBe(remediation);
  expect(result.issues).toEqual([{ path, message: cause.message }]);
});

test.each(wrappers)("$name wraps a non-Error cause", ({ wrap, path, fallback, remediation }) => {
  // Given
  const cause = { detail: "not an Error" };
  // When
  const result = wrap(cause);
  // Then
  expect(result).toBeInstanceOf(LandofileValidationError);
  expect(result.file).toBe("/app/.lando.yml");
  expect(result.message).toBe(fallback);
  expect(result.remediation).toBe(remediation);
  expect(result.issues).toEqual([{ path, message: fallback }]);
});
