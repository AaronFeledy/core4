import { expect, test } from "bun:test";
import { LandoEvent, PostGlobalDestroyEvent, PreGlobalDestroyEvent } from "@lando/sdk/events";
import { DateTime, Schema } from "effect";

const app = { kind: "global", id: "global", root: "/isolated/global" } as const;
const timestamp = "2026-10-21T00:00:00.000Z";

test.each(["applied", "orphans", "owned"] as const)(
  "global destroy %s payload survives the public event codec",
  (evidence) => {
    // Given wire events with the complete global destroy contract.
    const pre = {
      _tag: "pre-global-destroy",
      scope: "global",
      app,
      evidence,
      purge: true,
      timestamp,
    } as const;
    const post = { ...pre, _tag: "post-global-destroy", outcome: "unchanged" } as const;
    // When consumers decode through the public union and specific event schemas.
    const decodedPre = Schema.decodeUnknownSync(PreGlobalDestroyEvent)(pre);
    const decodedPost = Schema.decodeUnknownSync(PostGlobalDestroyEvent)(post);
    // Then fields survive union encoding, including the timestamp and no-op outcome.
    expect(Schema.encodeSync(LandoEvent)(decodedPre)).toEqual(pre);
    expect(Schema.encodeSync(LandoEvent)(decodedPost)).toEqual(post);
    expect(DateTime.formatIso(decodedPost.timestamp)).toBe(timestamp);
    expect(Schema.decodeUnknownSync(LandoEvent)(post)).toEqual(decodedPost);
  },
);

test.each(["pre-global-destroy", "post-global-destroy"] as const)("%s rejects absent evidence", (tag) => {
  // Given a payload that would falsely claim a bracket for absent evidence.
  const wire = {
    _tag: tag,
    scope: "global",
    app,
    evidence: "absent",
    purge: false,
    outcome: "unchanged",
    timestamp,
  };
  // When the public decoder checks the payload.
  const result = Schema.decodeUnknownResult(LandoEvent)(wire);
  // Then absent cannot enter the destroy lifecycle stream.
  expect(result._tag).toBe("Failure");
});
