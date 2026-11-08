import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { FileSyncSelectionError, LandofileParseError } from "@lando/sdk/errors";
import { AppPlanner, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { withResolvedCwd } from "../../src/landofile/app-resolution.ts";
import { infoApp, infoForPlan } from "../../src/operations/info.ts";
import { identityPlan, identityRegistry } from "./data-identity-support.ts";
import { makeHarness } from "./start-progress-topology-support.ts";

test.each([
  { dataName: "original", expected: "original" },
  { dataName: "current", expected: undefined },
  { dataName: undefined, expected: undefined },
])("info reports the retained data name only when it differs: $dataName", async ({ dataName, expected }) => {
  const plan = { ...identityPlan("current", dataName), services: {} };
  const result = await Effect.runPromise(
    infoForPlan(plan).pipe(Effect.provideService(RuntimeProviderRegistry, identityRegistry([plan]))),
  );
  expect(result.app).toBe("current");
  expect(result.dataName).toBe(expected);
  expect(Object.hasOwn(result, "dataName")).toBe(expected !== undefined);
});

test.each(["loaded", "planning-failed", "unavailable"] as const)(
  "info uses the current name with applied services when the Landofile is %s",
  async (state) => {
    const applied = identityPlan("original", "original");
    const desired = identityPlan("renamed", "original");
    const harness = makeHarness({
      plannedApp: desired,
      appliedPlans: [applied],
      resolveAppliedPlan: () => Effect.succeed(applied),
    });
    const failure = new LandofileParseError({
      filePath: `${desired.root}/.lando.yml`,
      line: undefined,
      column: undefined,
      message: "Invalid Landofile",
      remediation: "Correct the Landofile.",
    });
    const invocation = infoApp().pipe(
      Effect.provideService(AppPlanner, {
        plan: () =>
          state === "planning-failed"
            ? Effect.fail(
                new FileSyncSelectionError({
                  reason: "missing",
                  candidates: [],
                  message: "Missing sync engine",
                  remediation: "Install the engine.",
                }),
              )
            : Effect.succeed({ ...desired, valueModel: 1 as const }),
      }),
    );
    try {
      const result = await Effect.runPromise(
        withResolvedCwd(
          desired.root,
          state === "unavailable"
            ? invocation.pipe(Effect.provideService(LandofileService, { discover: Effect.fail(failure) }))
            : invocation,
        ).pipe(Effect.provide(harness.layer)),
      );
      expect(result.app).toBe(state === "unavailable" ? "original" : "renamed");
      expect(result.dataName).toBe(state === "unavailable" ? undefined : "original");
      expect(result.services.map(({ app, service, type }) => ({ app, service, type }))).toEqual(
        Object.values(applied.services).map(({ name, type }) => ({
          app: String(applied.id),
          service: String(name),
          type,
        })),
      );
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);
