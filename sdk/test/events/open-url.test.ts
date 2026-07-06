import { describe, expect, test } from "bun:test";

import { DateTime, Either, Schema } from "effect";

import {
  type LandoEvent,
  LandoEvent as LandoEventSchema,
  PostOpenUrlEvent,
  PreOpenUrlEvent,
} from "@lando/sdk/events";

const FIXED_TIMESTAMP = DateTime.unsafeMake("2026-07-06T08:00:00Z");

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
  ["pre-open-url", PreOpenUrlEvent],
  ["post-open-url", PostOpenUrlEvent],
] as const;

describe("open-url events", () => {
  for (const [tag, schema] of openUrlEvents) {
    test(`${tag} round-trips through its schema`, () => {
      const decoded = Schema.decodeUnknownEither(schema)({ _tag: tag, ...basePayload });
      expect(Either.isRight(decoded)).toBe(true);
      if (Either.isRight(decoded)) {
        expect(decoded.right._tag).toBe(tag);
        expect(decoded.right.url).toBe("https://web.myapp.lndo.site");
        expect(decoded.right.app.id).toBe("myapp");
      }
    });

    test(`${tag} is a member of the LandoEvent union`, () => {
      const decoded = Schema.decodeUnknownEither(LandoEventSchema)({ _tag: tag, ...basePayload });
      expect(Either.isRight(decoded)).toBe(true);
      if (Either.isRight(decoded)) {
        const event: LandoEvent = decoded.right;
        expect(event._tag).toBe(tag);
      }
    });
  }
});
