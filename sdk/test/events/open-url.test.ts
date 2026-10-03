import { describe, expect, test } from "bun:test";

import { DateTime, Result, Schema } from "effect";

import {
  type LandoEvent,
  LandoEvent as LandoEventSchema,
  PostOpenUrlEvent,
  PreOpenUrlEvent,
} from "@lando/sdk/events";

const FIXED_TIMESTAMP = DateTime.makeUnsafe("2026-07-06T08:00:00Z");

const appRefFixture = {
  kind: "user",
  id: "myapp",
  root: "/srv/apps/myapp",
} as const;

const basePayload = {
  app: appRefFixture,
  url: "https://web.myapp.lndo.site",
  timestamp: DateTime.formatIso(FIXED_TIMESTAMP),
};

const openUrlEvents = [
  ["pre-open-url", Schema.decodeUnknownResult(PreOpenUrlEvent)],
  ["post-open-url", Schema.decodeUnknownResult(PostOpenUrlEvent)],
] as const;

describe("open-url events", () => {
  for (const [tag, decode] of openUrlEvents) {
    test(`${tag} round-trips through its schema`, () => {
      const decoded = decode({ _tag: tag, ...basePayload });
      expect(decoded._tag).toBe("Success");
      if (decoded._tag === "Success") {
        expect(String(decoded.success._tag)).toBe(tag);
        expect(decoded.success.url).toBe("https://web.myapp.lndo.site");
        expect(String(decoded.success.app.id)).toBe("myapp");
      }
    });

    test(`${tag} is a member of the LandoEvent union`, () => {
      const decoded = Schema.decodeUnknownResult(LandoEventSchema)({ _tag: tag, ...basePayload });
      expect(Result.isSuccess(decoded)).toBe(true);
      if (Result.isSuccess(decoded)) {
        const event: LandoEvent = decoded.success;
        expect(String(event._tag)).toBe(tag);
      }
    });
  }
});
