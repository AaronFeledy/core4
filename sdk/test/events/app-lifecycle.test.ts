import { describe, expect, test } from "bun:test";

import { DateTime, Either, ParseResult, Schema } from "effect";

import {
  BuildStepSkipEvent,
  PostAppStartEvent,
  PostAppStopEvent,
  PostBuildEvent,
  PostServiceStartEvent,
  PostServiceStopEvent,
  PreAppStartEvent,
  PreAppStopEvent,
  PreBuildEvent,
  PreServiceStartEvent,
  PreServiceStopEvent,
} from "@lando/sdk/events";

const FIXED_TIMESTAMP = DateTime.unsafeMake("2026-05-11T07:30:00Z");

const appRefFixture = {
  kind: "user",
  id: "myapp",
  root: "/srv/apps/myapp",
} as const;

const basePayload = {
  appRef: appRefFixture,
  providerId: "lando",
  timestamp: DateTime.formatIso(FIXED_TIMESTAMP),
};

const appLifecycleEvents = [
  ["pre-app-start", Schema.decodeUnknownEither(PreAppStartEvent)],
  ["post-app-start", Schema.decodeUnknownEither(PostAppStartEvent)],
  ["pre-app-stop", Schema.decodeUnknownEither(PreAppStopEvent)],
  ["post-app-stop", Schema.decodeUnknownEither(PostAppStopEvent)],
  ["pre-build", Schema.decodeUnknownEither(PreBuildEvent)],
  ["post-build", Schema.decodeUnknownEither(PostBuildEvent)],
] as const;

const serviceLifecycleEvents = [
  ["pre-service-start", Schema.decodeUnknownEither(PreServiceStartEvent)],
  ["post-service-start", Schema.decodeUnknownEither(PostServiceStartEvent)],
  ["pre-service-stop", Schema.decodeUnknownEither(PreServiceStopEvent)],
  ["post-service-stop", Schema.decodeUnknownEither(PostServiceStopEvent)],
] as const;

describe("app lifecycle event payload schemas", () => {
  test("decode app and build lifecycle payloads with pinned eventName literals", () => {
    for (const [eventName, decode] of appLifecycleEvents) {
      const result = decode({
        _tag: eventName,
        eventName,
        ...basePayload,
      });

      expect(result._tag).toBe("Right");
      if (result._tag === "Right") {
        expect(String(result.right.eventName)).toBe(eventName);
        expect(String(result.right.appRef.id)).toBe("myapp");
        expect(String(result.right.providerId)).toBe("lando");
      }
    }
  });

  test("decode service lifecycle payloads with serviceName", () => {
    for (const [eventName, decode] of serviceLifecycleEvents) {
      const result = decode({
        _tag: eventName,
        eventName,
        ...basePayload,
        serviceName: "web",
      });

      expect(result._tag).toBe("Right");
      if (result._tag === "Right") {
        expect(String(result.right.eventName)).toBe(eventName);
        expect(String(result.right.serviceName)).toBe("web");
      }
    }
  });

  test("rejects a mismatched eventName with a structured ParseError", () => {
    const result = Schema.decodeUnknownEither(PreAppStartEvent)({
      _tag: "pre-app-start",
      eventName: "post-app-start",
      ...basePayload,
    });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some((issue) => issue.path.includes("eventName"))).toBe(true);
    }
  });

  test("rejects service lifecycle payloads missing serviceName", () => {
    const result = Schema.decodeUnknownEither(PreServiceStartEvent)({
      _tag: "pre-service-start",
      eventName: "pre-service-start",
      ...basePayload,
    });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((issue) => issue.path.includes("serviceName"))).toBe(true);
    }
  });

  test("decodes build step skip payloads with cache reason fields", () => {
    const result = Schema.decodeUnknownEither(BuildStepSkipEvent)({
      _tag: "build-step-skip",
      eventName: "build-step-skip",
      appRef: { kind: "scratch", id: "scratch-toolbox" },
      serviceName: "web",
      providerId: "lando",
      phase: "artifact",
      buildKey: "a".repeat(64),
      cached: true,
      reason: "up-to-date",
      timestamp: DateTime.formatIso(FIXED_TIMESTAMP),
    });

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.eventName).toBe("build-step-skip");
      expect(result.right.appRef.kind).toBe("scratch");
      expect(result.right.cached).toBe(true);
    }
  });
});
