import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AbsolutePath } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import { defineTransitions, illegalTransitionMessage } from "@lando/sdk/transitions";
import { Effect, Schema } from "effect";
import * as StateStoreLayer from "../src/service.ts";
import { makeTestStateStore } from "../src/testing.ts";

const Claim = Schema.Struct({ phase: Schema.Literals(["open", "closed"]), owner: Schema.String });
type Claim = typeof Claim.Type;

const claimTransitions = defineTransitions<"absent" | Claim["phase"]>()({
  open: { from: ["absent"], to: "open", settledIn: ["open"] },
  close: { from: ["open"], to: "closed", settledIn: ["closed"] },
  forget: { from: ["closed"], to: "absent", settledIn: ["absent"] },
});

class ClaimRefused extends Schema.TaggedError<ClaimRefused>()("ClaimRefused", { message: Schema.String }) {}

const step = (operation: keyof typeof claimTransitions.edges, owner = "me") => ({
  transitions: claimTransitions,
  operation,
  state: (current: Claim | null) => current?.phase ?? "absent",
  next: (to: "absent" | Claim["phase"]) => (to === "absent" ? null : { phase: to, owner }),
  illegal: (verdict: Parameters<typeof illegalTransitionMessage>[2]) =>
    new ClaimRefused({ message: illegalTransitionMessage("Claim", operation, verdict) }),
});

const spec = {
  root: { path: AbsolutePath.make("/tmp/lando-bucket-transition") },
  key: "claim.json",
} as const;

describe("StateBucket.transition", () => {
  test("stores the operation's state, keeps a settled record, and removes on absent", async () => {
    // Given an empty claim bucket
    const memory = makeTestStateStore();
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const bucket = yield* memory.service.open({ ...spec, schema: Claim, version: 1, lock: "advisory" });
        // When the claim opens, is re-opened by someone else, closes, and is forgotten
        const opened = yield* bucket.transition(step("open"));
        const reopened = yield* bucket.transition(step("open", "someone-else"));
        const closed = yield* bucket.transition(step("close"));
        const forgotten = yield* bucket.transition(step("forget"));
        return { opened, reopened, closed, forgotten, exists: yield* bucket.exists };
      }),
    );
    // Then a settled operation keeps the original record and forgetting deletes the file
    expect(outcome).toEqual({
      opened: { phase: "open", owner: "me" },
      reopened: { phase: "open", owner: "me" },
      closed: { phase: "closed", owner: "me" },
      forgotten: null,
      exists: false,
    });
  });

  test("refuses an undeclared edge with the owner's error and leaves the record untouched", async () => {
    // Given an open claim
    const memory = makeTestStateStore();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const bucket = yield* memory.service.open({ ...spec, schema: Claim, version: 1 });
        yield* bucket.transition(step("open"));
        const before = memory.snapshot();
        // When forget runs before close
        const refused = yield* Effect.flip(bucket.transition(step("forget")));
        return { refused, before: before.get(bucket.path), after: memory.snapshot().get(bucket.path) };
      }),
    );
    // Then the owner's tagged error names the refused edge and nothing was written
    expect(result.refused).toBeInstanceOf(ClaimRefused);
    expect(result.refused.message).toBe(
      "Claim cannot forget while open; forget only moves closed to absent.",
    );
    expect(result.after).toEqual(result.before);
  });
});

describe("StateBucket.mutate", () => {
  test("keeps the file byte-identical on Keep and fails without writing", async () => {
    // Given a stored record on disk
    const dir = await mkdtemp(join(tmpdir(), "lando-bucket-mutate-"));
    try {
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* StateStore;
          const bucket = yield* store.open({
            root: { path: AbsolutePath.make(dir) },
            key: "claim.json",
            schema: Claim,
            version: 1,
            lock: "advisory",
          });
          yield* bucket.set({ phase: "open", owner: "me" });
          const before = yield* Effect.promise(() => Bun.file(bucket.path).stat());
          // When a mutation keeps the record, and another fails
          const kept = yield* bucket.mutate(() => Effect.succeed({ _tag: "Keep", result: "kept" } as const));
          const failed = yield* Effect.flip(
            bucket.mutate(() => Effect.fail(new ClaimRefused({ message: "no" }))),
          );
          const after = yield* Effect.promise(() => Bun.file(bucket.path).stat());
          return { kept, failed, sameInode: before.ino === after.ino && before.mtimeMs === after.mtimeMs };
        }).pipe(Effect.provide(StateStoreLayer.layer)),
      );
      // Then neither call replaced the file
      expect(outcome.kept).toBe("kept");
      expect(outcome.failed).toBeInstanceOf(ClaimRefused);
      expect(outcome.sameInode).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
