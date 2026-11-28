import { expect, test } from "bun:test";
import { ScratchAppService } from "@lando/sdk/services";
import { Effect } from "effect";
import { runDestroy, withDestroyFixture } from "./destroy-fixture.ts";

test("explicit destroy retires a scratch from another engine and warns how to clean up verified orphans", () =>
  withDestroyFixture({ appliedPlan: "other-engine" }, async (f) => {
    await runDestroy(f);
    expect(f.entries.has(f.id)).toBe(false);
    expect(f.receipt()).toBeUndefined();
    const warnings = f.events.flatMap((event) => (event._tag === "message.warn" ? [event.body] : []));
    expect(warnings).toContainEqual(expect.stringContaining("tcp://old.example:2375"));
    expect(warnings).toContainEqual(expect.stringContaining("lando scratch:gc --prune"));
    expect(warnings.join(" ")).not.toContain("secret");
  }));

test("GC retains a scratch on another engine and reports the placement mismatch", () =>
  withDestroyFixture({ appliedPlan: "other-engine" }, async (f) => {
    const report = await Effect.runPromise(
      Effect.flatMap(ScratchAppService, (scratch) => scratch.gc({ prune: true })).pipe(
        Effect.provide(f.layer),
      ),
    );
    expect(report.candidates).toContain(f.id);
    expect(report.reaped).toEqual([]);
    expect(report.errors).toContainEqual(expect.stringContaining("tcp://old.example:2375"));
    expect(report.errors).toContainEqual(expect.stringContaining("unix:///current.sock"));
    expect(f.entries.has(f.id)).toBe(true);
    expect(f.receipt()?.id).toBe(f.id);
    expect(f.calls).not.toContain("stop");
  }));
