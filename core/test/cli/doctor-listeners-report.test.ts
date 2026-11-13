import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { metaDoctorSpec } from "../../src/cli/command-specs/meta/doctor.ts";
import { doctorReport } from "../../src/cli/commands/doctor-report.ts";
import { listenerProvider, listenerReportLayers, withListenerApp } from "./doctor-listeners-fixture.ts";
import { healthyFilesystemWatch } from "./doctor-watch-fixture.ts";

test("preserves provider results and success when the app listener section exhausts its budget", async () => {
  // Given a readable applied plan whose listener inspection cannot finish.
  await withListenerApp(async (plan) => {
    await writeFile(join(plan.root, ".lando.yml"), "name: listener-demo\nlando: '>=0'\n");
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const provider = listenerProvider(plan, {
          list: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        });
        // When the full report reaches the listener deadline on the virtual clock.
        const fiber = yield* Effect.forkChild(
          doctorReport({
            app: true,
            flagProviderId: "lando",
            env: { LANDO_DOCTOR_SECTION_BUDGET_MS: "1000" },
          }).pipe(Effect.provide(listenerReportLayers(plan, provider))),
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust("1000 millis");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(healthyFilesystemWatch), Effect.provide(TestClock.layer())),
    );
    // Then the provider verdict survives and listener unavailability cannot fail completion.
    expect(report.checks.filter((check) => check.section === "provider")).toContainEqual(
      expect.objectContaining({ name: "selected-provider" }),
    );
    expect(report.checks.filter((check) => check.section === "app-listeners")).toEqual([]);
    expect(report.skipped).toContainEqual({
      section: "app-listeners",
      reason: expect.stringMatching(/^timeout:/),
    });
    expect(report.checks.some((check) => check.name === "doctor-self")).toBe(false);
    expect(report.checks.some((check) => check.section === "app-config" && check.status === "pass")).toBe(
      true,
    );
    expect(metaDoctorSpec.completion?.(report, {})).toEqual({ ok: true, exitCode: 0 });
  });
});
