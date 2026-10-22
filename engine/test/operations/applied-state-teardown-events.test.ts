import { expect, test } from "bun:test";
import { join } from "node:path";
import { AppId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { withResolvedCwd } from "../../src/landofile/app-resolution.ts";
import { destroyApp, destroyAppAtRoot } from "../../src/operations/destroy.ts";
import { stopApp } from "../../src/operations/stop.ts";
import { attachEffectiveEvents, compiledEventsForPlan } from "../../src/planner/effective-events.ts";
import { attachEffectiveTooling } from "../../src/planner/effective-tooling.ts";
import {
  authoredPlan,
  authoredTeardownHarness,
  invalidLandofile,
  recordedPlan,
  targetFor,
  withTeardownRoot,
} from "./teardown-authored-events-support.ts";

test.each(["stop", "destroy"] as const)(
  "cwd %s restores authored init and teardown steps on the recorded plan",
  async (operation) => {
    await withTeardownRoot(async (root) => {
      // Given distinct desired/applied plan objects, as after a provider-state round trip.
      const applied = recordedPlan(root);
      const desired = authoredPlan(root);
      const harness = authoredTeardownHarness({ applied, desired });
      expect(compiledEventsForPlan(applied)).toBeUndefined();
      // When
      await Effect.runPromise(
        withResolvedCwd(
          root,
          operation === "stop" ? stopApp().pipe(Effect.asVoid) : destroyApp().pipe(Effect.asVoid),
        ).pipe(Effect.provide(harness.layer)),
      );
      // Then: init precedes the bracket; the provider still receives the original recorded object.
      const ordered = new Set(["pre-init", "post-init", `pre-${operation}`, `post-${operation}`, "provider"]);
      expect(harness.order.filter((item) => ordered.has(item) || item.startsWith("step:"))).toEqual([
        "pre-init",
        "step:pre-init",
        "post-init",
        "step:post-init",
        `pre-${operation}`,
        ...(operation === "destroy" ? ["step:app:config", "step:app:info"] : ["step:pre-stop"]),
        "provider",
        ...(operation === "stop" ? ["post-stop", "step:post-stop"] : ["step:post-destroy", "post-destroy"]),
      ]);
      expect(harness.destroyed[0]).toBe(applied);
      expect(harness.stepPlans.every((plan) => plan === applied)).toBe(true);
      expect(harness.order.filter((item) => item === "load")).toHaveLength(1);
      expect(harness.order.indexOf("evidence")).toBeLessThan(harness.order.indexOf("load"));
    });
  },
);

test.each(["stop", "destroy"] as const)(
  "cwd %s runs current authored tooling tasks against the recorded plan",
  async (operation) => {
    await withTeardownRoot(async (root) => {
      // Given a recorded plan without attachments and current task-backed teardown steps.
      const applied = recordedPlan(root);
      const desired = attachEffectiveTooling(
        attachEffectiveEvents(recordedPlan(root), { [`pre-${operation}`]: [{ task: "cleanup" }] }),
        { cleanup: { cmd: "echo teardown" } },
      );
      const harness = authoredTeardownHarness({ applied, desired });
      // When
      await Effect.runPromise(
        withResolvedCwd(
          root,
          operation === "stop" ? stopApp().pipe(Effect.asVoid) : destroyApp().pipe(Effect.asVoid),
        ).pipe(Effect.provide(harness.layer)),
      );
      // Then the task executes before teardown using the applied, not the desired, plan.
      expect(harness.toolInvocations.map(({ commands }) => commands)).toEqual([
        [["sh", "-c", 'echo teardown "$@"', "lando-tooling"]],
      ]);
      expect(harness.stepPlans).toEqual([applied]);
      expect(harness.stepPlans[0]).toBe(applied);
      expect(harness.order.indexOf("tool:cleanup")).toBeLessThan(harness.order.indexOf("provider"));
      expect(harness.destroyed[0]).toBe(applied);
    });
  },
);

test.each(["load", "plan"] as const)(
  "destroy succeeds with one info notice when desired %s fails",
  async (failure) => {
    await withTeardownRoot(async (root) => {
      // Given
      const applied = recordedPlan(root);
      const harness = authoredTeardownHarness({
        applied,
        ...(failure === "plan" ? { desired: authoredPlan(root), plannerFailure: invalidLandofile } : {}),
      });
      // When
      const result = await Effect.runPromise(
        withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer)),
      );
      // Then
      expect(result.outcome).toBe("destroyed");
      expect(harness.events.filter((event) => event._tag === "message.info")).toHaveLength(1);
      expect(harness.stepPlans).toEqual([]);
      expect(harness.order.indexOf("message.info")).toBeLessThan(harness.order.indexOf("pre-destroy"));
      expect(harness.destroyed[0]).toBe(applied);
    });
  },
);

test("destroy skips authored steps with a notice when desired identity differs", async () => {
  await withTeardownRoot(async (root) => {
    // Given
    const applied = { ...recordedPlan(root), id: AppId.make("previous-app") };
    const harness = authoredTeardownHarness({ applied, desired: authoredPlan(root) });
    // When
    const result = await Effect.runPromise(
      withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer)),
    );
    // Then
    expect(result.outcome).toBe("destroyed");
    expect(harness.events.filter((event) => event._tag === "message.info")).toHaveLength(1);
    expect(harness.stepPlans).toEqual([]);
    expect(harness.destroyed[0]).toBe(applied);
  });
});

test("missing-root destroy skips desired loading and publishes no info notice", async () => {
  await withTeardownRoot(async (parent) => {
    // Given
    const root = join(parent, "gone");
    const applied = recordedPlan(root);
    const harness = authoredTeardownHarness({ applied });
    // When
    const result = await Effect.runPromise(destroyAppAtRoot(root).pipe(Effect.provide(harness.layer)));
    // Then
    expect(result.outcome).toBe("destroyed");
    expect(harness.events.filter((event) => event._tag === "message.info")).toEqual([]);
    expect(harness.order).not.toContain("load");
    expect(harness.stepPlans).toEqual([]);
  });
});

test("explicit desired destroy reuses compiled events without loading again", async () => {
  await withTeardownRoot(async (root) => {
    // Given
    const applied = recordedPlan(root);
    const desired = authoredPlan(root);
    const harness = authoredTeardownHarness({ applied });
    // When
    await Effect.runPromise(
      destroyApp({}, { ...targetFor(desired), landofile: { name: desired.name, services: {} } }).pipe(
        Effect.provide(harness.layer),
      ),
    );
    // Then
    expect(harness.order.filter((item) => item.startsWith("step:"))).toEqual([
      "step:pre-init",
      "step:post-init",
      "step:app:config",
      "step:app:info",
      "step:post-destroy",
    ]);
    expect(harness.order).not.toContain("load");
    expect(harness.destroyed[0]).toBe(applied);
  });
});
