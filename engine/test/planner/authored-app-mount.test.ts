import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import { ServicePlan, formatValidationIssuePath } from "@lando/sdk/schema";

import { applyAuthoredAppMount } from "../../src/planner/authored.ts";

const plan = Schema.decodeUnknownSync(ServicePlan)({
  name: "web",
  type: "test",
  provider: "lando",
  primary: true,
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  extensions: {},
  metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "/srv/project/.lando.yml", runtime: 4 },
  appMount: {
    source: "/srv/project",
    target: "/app",
    readOnly: false,
    excludes: ["vendor"],
    includes: [],
    realization: "passthrough",
  },
});

describe("authored app-mount validation", () => {
  test("preserves feature-owned intent when authored policy differs", () => {
    // Given a feature-owned mount and authored values that the feature would merge.
    const service = { appMount: { target: "/site", readOnly: true, excludes: ["dist"], includes: ["src"] } };
    // When the planner validates authored intent.
    const result = applyAuthoredAppMount(plan, service, "/srv/project", "web");
    // Then it leaves composition's plan untouched.
    expect(result).toBe(plan);
  });

  test.each(["relative", "/", "/app/.."])(
    'rejects invalid target "%s" even without a contributed mount',
    (target) => {
      // Given a service without app-source intent and an invalid authored destination.
      const { appMount: _appMount, ...unmounted } = plan;
      // When authored intent is validated.
      const result = applyAuthoredAppMount(unmounted, { appMount: { target } }, "/srv/project", "web");
      // Then the failure points at the authored field.
      expect(result).toBeInstanceOf(LandofileValidationError);
      if (!(result instanceof LandofileValidationError))
        throw new Error("Expected destination validation error");
      expect(result.issues.map((issue) => formatValidationIssuePath(issue.path))).toEqual([
        "services.web.appMount.target",
      ]);
    },
  );
});
