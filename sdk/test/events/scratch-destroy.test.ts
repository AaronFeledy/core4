import { expect, test } from "bun:test";
import { LandoEvent, PostScratchDestroyEvent, PreScratchDestroyEvent } from "@lando/sdk/events";
import type { AppPlan } from "@lando/sdk/schema";
import { Schema } from "effect";

test.each(["explicit", "scope-close", "poweroff", "gc", "acquire-failure"] as const)(
  "scratch %s accepts a minimal orphan payload",
  (reason) => {
    // Given an orphan with no plan or registry metadata.
    const fields = {
      scope: "scratch",
      app: { kind: "scratch", id: "scratch-demo-123456", root: "/isolated/scratch-demo-123456" },
      reason,
      retainedArtifacts: { volumes: false, snapshots: "unknown-owner" },
      timestamp: "2026-10-21T00:00:00.000Z",
    } as const;
    const pre = { ...fields, _tag: "pre-scratch-destroy" } as const;
    const post = { ...fields, _tag: "post-scratch-destroy" } as const;
    // When consumers round trip the specific schemas through the public union.
    const decoded = Schema.decodeUnknownSync(PostScratchDestroyEvent)(post);
    // Then the skipped snapshot purge is explicit without invented acquisition metadata.
    expect(Schema.encodeSync(LandoEvent)(Schema.decodeUnknownSync(PreScratchDestroyEvent)(pre))).toEqual(pre);
    expect(Schema.encodeSync(LandoEvent)(decoded)).toEqual(post);
    expect(Schema.decodeUnknownSync(LandoEvent)(post)).toEqual(decoded);
  },
);

test("scratch destroy rejects a user app ref", () => {
  // Given a payload claiming a user app within a scratch bracket.
  const wire = {
    _tag: "pre-scratch-destroy",
    scope: "scratch",
    app: { kind: "user", id: "user", root: "/source" },
    reason: "explicit",
    retainedArtifacts: { volumes: false, snapshots: "none" },
    timestamp: "2026-10-21T00:00:00.000Z",
  };
  // When decoded through the public event union.
  const result = Schema.decodeUnknownResult(LandoEvent)(wire);
  // Then the invalid app kind is rejected at the schema boundary.
  expect(result._tag).toBe("Failure");
});

test.each(["pre-scratch-destroy", "post-scratch-destroy"] as const)(
  "%s preserves an available scratch plan through the public codec",
  (_tag) => {
    // Given a planned scratch destroy payload.
    const plan = {
      id: "scratch-demo-123456",
      name: "demo",
      slug: "demo",
      root: "/isolated/scratch-demo-123456/root",
      provider: "lando",
      services: {},
      routes: [],
      stores: [],
      fileSync: [],
      metadata: { resolvedAt: "2026-10-21T00:00:00.000Z", source: "test", runtime: 4 },
      extensions: {},
    } satisfies typeof AppPlan.Encoded;
    const wire = {
      _tag,
      scope: "scratch",
      app: { kind: "scratch", id: plan.id, root: plan.root },
      plan,
      reason: "explicit",
      retainedArtifacts: { volumes: false, snapshots: "none" },
      timestamp: "2026-10-21T00:00:00.000Z",
    };
    // When the event is decoded and encoded by the public union.
    const encoded = Schema.encodeSync(LandoEvent)(Schema.decodeUnknownSync(LandoEvent)(wire));
    // Then consumers receive the original plan rather than silently losing it.
    expect(encoded).toMatchObject({ plan });
  },
);
