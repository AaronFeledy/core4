import { describe, expect, test } from "bun:test";

import { LandofileValidationError } from "@lando/sdk/errors";
import { formatValidationIssuePath } from "@lando/sdk/schema";

import { validateAuthoredAppMount } from "../../src/planner/authored.ts";

describe("authored app-mount validation", () => {
  test("accepts authored policy without composing a mount", () => {
    // Given
    const service = { appMount: { target: "/site", readOnly: true, excludes: ["dist"], includes: ["src"] } };
    // When
    const result = validateAuthoredAppMount(service, "/srv/project", "web");
    // Then
    expect(result).toBeUndefined();
  });

  test.each(["relative", "/", "/app/.."])(
    'rejects invalid target "%s" even without a contributed mount',
    (target) => {
      // Given
      const service = { appMount: { target } };
      // When
      const result = validateAuthoredAppMount(service, "/srv/project", "web");
      // Then
      expect(result).toBeInstanceOf(LandofileValidationError);
      if (!(result instanceof LandofileValidationError))
        throw new Error("Expected destination validation error");
      expect(result.issues.map((issue) => formatValidationIssuePath(issue.path))).toEqual([
        "services.web.appMount.target",
      ]);
    },
  );
});
