import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";
import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest, type ValidationIssue } from "@lando/sdk/schema";
import { AppPlanner, type ServiceType } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as Plugins from "../../src/plugins/registry.ts";
import { lintLandofileSnapshot } from "../../src/services/landofile-live.ts";
import * as Planner from "../../src/services/planner.ts";

const cases: readonly {
  readonly label: string;
  readonly issues: readonly ValidationIssue[] | undefined;
  readonly path: readonly string[];
  readonly suggestion: string;
}[] = [
  { label: "omitted issues", issues: undefined, path: [], suggestion: "Repair the listener declaration." },
  { label: "empty issues", issues: [], path: [], suggestion: "Repair the listener declaration." },
  {
    label: "issue without suggestion",
    issues: [{ path: ["port"], message: "Invalid listener" }],
    path: ["port"],
    suggestion: "Repair the listener declaration.",
  },
  {
    label: "explicit suggestion",
    issues: [{ path: ["port"], message: "Invalid listener", suggestion: "Use port 8080." }],
    path: ["port"],
    suggestion: "Use port 8080.",
  },
];

describe.each(["type", "feature"] as const)("service %s remediation", (kind) => {
  describe.each(["planner", "lint"] as const)("%s aggregation", (surface) => {
    test.each(cases)("retains remediation for $label", async ({ issues, path, suggestion }) => {
      // Given
      const root = await mkdtemp(join(tmpdir(), "lando-service-remediation-"));
      try {
        const file = join(root, ".lando.yml");
        await writeFile(
          file,
          "name: remediation\nservices:\n  web:\n    type: remediation-test\n    home: false\n",
        );
        const fields = {
          message: "Invalid listener",
          remediation: "Repair the listener declaration.",
          issues,
        };
        const serviceType: ServiceType = {
          id: "remediation-test",
          name: "remediation-test",
          base: "l337",
          schema: Schema.Unknown,
          resolve: (input) =>
            kind === "type"
              ? Effect.fail(new ServiceTypeError({ ...fields, serviceType: "remediation-test" }))
              : Effect.succeed({
                  base: "l337",
                  normalizedConfig: input.service,
                  features: [{ id: "remediation.feature" }],
                }),
        };
        const plugin = definePlugin({
          name: "@test/remediation",
          manifest: Schema.decodeUnknownSync(PluginManifest)({
            name: "@test/remediation",
            version: "1.0.0",
            api: 4,
            contributes: { serviceTypes: [serviceType.id], serviceFeatures: ["remediation.feature"] },
          }),
          serviceTypes: new Map([[serviceType.id, serviceType]]),
          serviceFeatures: new Map([
            [
              "remediation.feature",
              {
                id: "remediation.feature",
                priority: 100,
                apply: () => Effect.void,
                declareEndpoints: () =>
                  Effect.fail(new ServiceFeatureError({ ...fields, feature: "remediation.feature" })),
              },
            ],
          ]),
        });
        const registry = Plugins.layerWith({ app: false, user: false }, [plugin]);
        const expectedPath = ["services", "web", ...path];
        const expectedIssue = {
          path: expectedPath,
          message: "Invalid listener",
          suggestion,
          source: expect.objectContaining({ file, layer: "canonical", path: ["services", "web"] }),
        };

        // When
        if (surface === "planner") {
          const snapshot = await Effect.runPromise(lintLandofileSnapshot({ cwd: root }));
          if (snapshot.resolved === undefined) throw new Error("Expected resolved Landofile");
          const landofile = snapshot.resolved;
          const result = await Effect.runPromise(
            Effect.flatMap(AppPlanner, (planner) =>
              planner.plan(landofile, TestRuntimeProvider.capabilities),
            ).pipe(Effect.result, Effect.provide(Planner.layer), Effect.provide(registry)),
          );
          // Then
          if (!Result.isFailure(result)) throw new Error("Expected planner failure");
          expect(result.failure._tag).toBe("LandofileValidationError");
          if (result.failure._tag !== "LandofileValidationError") throw result.failure;
          expect(result.failure.issues).toEqual([expect.objectContaining(expectedIssue)]);
        } else {
          const result = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(registry)));
          // Then
          expect(result.valid).toBe(false);
          expect(result.violations.filter((issue) => issue.severity === "error")).toEqual([
            expect.objectContaining({ ...expectedIssue, severity: "error" }),
          ]);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
