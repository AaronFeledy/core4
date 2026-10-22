import { expect, test } from "bun:test";
import { AbsolutePath, AppId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { withTeardownAuthoredEvents } from "../../src/operations/teardown-authored-events.ts";
import { attachEffectiveEvents, compiledEventsForPlan } from "../../src/planner/effective-events.ts";
import {
  authoredPlan,
  authoredTeardownHarness,
  recordedPlan,
  targetFor,
  withTeardownRoot,
} from "./teardown-authored-events-support.ts";

test.each(["id", "root", "kind"] as const)(
  "does not borrow authored events across a different %s",
  async (field) => {
    await withTeardownRoot(async (root) => {
      // Given
      const applied = targetFor(recordedPlan(root));
      const desired = targetFor(authoredPlan(root));
      const mismatched = {
        ...desired,
        root: field === "root" ? AbsolutePath.make(`${root}/other`) : desired.root,
        app: {
          ...desired.app,
          id: field === "id" ? AppId.make("other") : desired.app.id,
          kind: field === "kind" ? ("scratch" as const) : desired.app.kind,
        },
      };
      const harness = authoredTeardownHarness({ applied: applied.plan });
      // When
      const result = await Effect.runPromise(
        withTeardownAuthoredEvents(applied, Effect.succeed(mismatched)).pipe(Effect.provide(harness.layer)),
      );
      // Then
      expect(result).toBe(applied);
      expect(compiledEventsForPlan(applied.plan)).toBeUndefined();
      expect(harness.events.filter((event) => event._tag === "message.info")).toHaveLength(1);
    });
  },
);

test.each([false, true])(
  "does not resolve desired config for an already attached plan (empty=%s)",
  async (empty) => {
    await withTeardownRoot(async (root) => {
      // Given
      const plan = empty ? attachEffectiveEvents(recordedPlan(root), {}) : authoredPlan(root);
      const applied = targetFor(plan);
      const harness = authoredTeardownHarness({ applied: plan });
      // When
      const result = await Effect.runPromise(
        withTeardownAuthoredEvents(applied, Effect.die("must not resolve desired config")).pipe(
          Effect.provide(harness.layer),
        ),
      );
      // Then
      expect(result).toBe(applied);
      expect(harness.events).toEqual([]);
    });
  },
);

test("preserves compiled host provenance and dedupe while retaining the applied target", async () => {
  await withTeardownRoot(async (root) => {
    // Given
    const applied = targetFor(recordedPlan(root));
    const desired = targetFor(authoredPlan(root));
    const harness = authoredTeardownHarness({ applied: applied.plan });
    // When
    const result = await Effect.runPromise(
      withTeardownAuthoredEvents(applied, Effect.succeed(desired)).pipe(Effect.provide(harness.layer)),
    );
    // Then
    expect(result).toBe(applied);
    expect(
      compiledEventsForPlan(applied.plan)?.["pre-destroy"]?.map(({ source, sourceIndex, status }) => ({
        source,
        sourceIndex,
        status,
      })),
    ).toEqual([
      { source: "host", sourceIndex: 0, status: "active" },
      { source: "host", sourceIndex: 1, status: "deduped" },
      { source: "project", sourceIndex: 0, status: "active" },
    ]);
    expect(harness.events).toEqual([]);
  });
});
