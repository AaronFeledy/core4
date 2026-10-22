import { expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppId, AppPlan } from "@lando/sdk/schema";
import { ScratchAppService } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { runDestroy, withDestroyFixture } from "./destroy-fixture.ts";

const bracket = [
  "pre-scratch-destroy",
  "pre-stop",
  "post-stop",
  "pre-destroy",
  "post-destroy",
  "post-scratch-destroy",
];

test("explicit scratch destroy nests standard events and removes its snapshots before cleanup", async () => {
  // Given a registered scratch plan with its own snapshots.
  await withDestroyFixture({}, async (f) => {
    // When explicit destroy completes.
    await runDestroy(f);
    // Then the full lifecycle and cleanup order is observable.
    expect(f.calls.filter((tag) => bracket.includes(tag))).toEqual(bracket);
    expect(f.calls.indexOf("pre-stop")).toBeLessThan(f.calls.indexOf("stop"));
    expect(f.calls.indexOf("stop")).toBeLessThan(f.calls.indexOf("post-stop"));
    expect(f.calls.indexOf("pre-destroy")).toBeLessThan(f.calls.indexOf("snapshot:remove"));
    expect(f.calls.indexOf("destroy:true")).toBeLessThan(f.calls.indexOf("post-destroy"));
    expect(f.events.find((event) => event._tag === "post-destroy")).toMatchObject({
      evidence: "applied",
      outcome: "destroyed",
    });
    expect(f.calls.indexOf("post-destroy")).toBeLessThan(f.calls.indexOf("registry"));
    expect(f.calls.at(-1)).toBe("post-scratch-destroy");
    expect(f.removed).toEqual([`${f.id}-snapshot`]);
    expect(f.entries.size).toBe(0);
    await expect(access(f.instanceRoot)).rejects.toThrow();
    for (const event of f.events.filter((event) => bracket.includes(event._tag)))
      expect(event).toMatchObject({ app: { kind: "scratch" } });
    expect(f.events.at(-1)).toMatchObject({
      reason: "explicit",
      retainedArtifacts: { volumes: false, snapshots: "none" },
    });
  });
});

test("poweroff reaps an unregistered scratch through the standard bracket", async () => {
  // Given a directory orphan without a usable plan.
  await withDestroyFixture({ orphan: true }, async (f) => {
    // When poweroff asks the scratch service to reap the discovered id.
    await Effect.runPromise(
      Effect.flatMap(ScratchAppService, (s) => s.destroy(f.id, { reason: "poweroff" })).pipe(
        Effect.provide(f.layer),
      ),
    );
    // Then the orphan uses the same lifecycle and retains snapshots with unknown ownership.
    expect(f.calls.filter((tag) => bracket.includes(tag))).toEqual(bracket);
    expect(f.events.at(-1)).toMatchObject({
      reason: "poweroff",
      retainedArtifacts: { snapshots: "unknown-owner" },
    });
  });
});

test("keep-volumes retains both volumes and snapshots", async () => {
  // Given a registered scratch with snapshots.
  await withDestroyFixture({}, async (f) => {
    // When destroy retains volumes.
    await runDestroy(f, true);
    // Then neither snapshots nor volumes are removed.
    expect(f.removed).toEqual([]);
    expect(f.calls).not.toContain("snapshots:list");
    expect(f.calls).toContain("destroy:false");
    expect(f.events.at(-1)).toMatchObject({ retainedArtifacts: { volumes: true, snapshots: "kept" } });
  });
});

test("cwd scratch destroy preserves user snapshots sharing the same owner", async () => {
  // Given user and scratch snapshots under the source app's owner key.
  await withDestroyFixture({ cwd: true }, async (f) => {
    // When the cwd fork is destroyed.
    await runDestroy(f);
    // Then only the scratch app id's snapshot is selected.
    expect(f.removed).toEqual([`${f.id}-snapshot`]);
    expect(f.removed).not.toContain("user-app-snapshot");
  });
});

test.each(["provider", "route"] as const)(
  "scratch %s failure retains registry state and suppresses completion",
  async (failure) => {
    // Given a provider failure during destroy.
    await withDestroyFixture({ fail: failure === "provider", routeFail: failure === "route" }, async (f) => {
      // When teardown fails after stopping the scratch.
      await expect(runDestroy(f)).rejects.toThrow();
      // Then the original registry entry survives and no completion event lies about cleanup.
      expect(f.entries.get(f.id)).toEqual(f.entry);
      expect(f.calls).toContain("pre-scratch-destroy");
      expect(f.calls).not.toContain("post-scratch-destroy");
      expect(f.calls).not.toContain("registry");
    });
  },
);

test("a mismatched cached plan cannot delete another app's snapshots", async () => {
  // Given a scratch cache containing a different app id under the same owner.
  await withDestroyFixture({ cwd: true }, async (f) => {
    await writeFile(
      join(f.instanceRoot, "plan.bin"),
      JSON.stringify(Schema.encodeSync(AppPlan)({ ...f.plan, id: AppId.make("user-app") })),
    );
    // When destroy reads that cache.
    await expect(runDestroy(f)).rejects.toThrow();
    // Then validation fails before events or destructive work.
    expect(f.calls).toEqual([]);
    expect(f.removed).toEqual([]);
    expect(f.entries.get(f.id)).toEqual(f.entry);
  });
});

test.each([false, true])("GC brackets scratch reaps without a task tree, orphan=%s", async (orphan) => {
  // Given a dead registered owner or a directory-only orphan.
  await withDestroyFixture({ orphan }, async (f) => {
    // When GC prunes it.
    const result = await Effect.runPromise(
      Effect.flatMap(ScratchAppService, (s) => s.gc({ prune: true })).pipe(Effect.provide(f.layer)),
    );
    // Then GC nests the same lifecycle, without foreground progress.
    expect(result.reaped).toEqual([f.id]);
    expect(f.calls.filter((tag) => bracket.includes(tag))).toEqual(bracket);
    expect(f.calls.some((tag) => tag.startsWith("task."))).toBe(false);
    expect(f.events.at(-1)).toMatchObject({
      reason: "gc",
      retainedArtifacts: { snapshots: orphan ? "unknown-owner" : "none" },
    });
    expect(f.removed).toEqual(orphan ? [] : [`${f.id}-snapshot`]);
  });
});
