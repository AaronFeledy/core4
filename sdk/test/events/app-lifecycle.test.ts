import { describe, expect, test } from "bun:test";

import { DateTime, Either, ParseResult, Schema } from "effect";

import {
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
  ["pre-app-start", PreAppStartEvent],
  ["post-app-start", PostAppStartEvent],
  ["pre-app-stop", PreAppStopEvent],
  ["post-app-stop", PostAppStopEvent],
  ["pre-build", PreBuildEvent],
  ["post-build", PostBuildEvent],
] as const;

const serviceLifecycleEvents = [
  ["pre-service-start", PreServiceStartEvent],
  ["post-service-start", PostServiceStartEvent],
  ["pre-service-stop", PreServiceStopEvent],
  ["post-service-stop", PostServiceStopEvent],
] as const;

describe("app lifecycle event payload schemas", () => {
  test("decode app and build lifecycle payloads with pinned eventName literals", () => {
    for (const [eventName, eventSchema] of appLifecycleEvents) {
      const result = Schema.decodeUnknownEither(eventSchema)({
        _tag: eventName,
        eventName,
        ...basePayload,
      });

      expect(Either.isRight(result)).toBe(true);
      if (Either.isRight(result)) {
        expect(result.right.eventName).toBe(eventName);
        expect(result.right.appRef.id).toBe("myapp");
        expect(result.right.providerId).toBe("lando");
      }
    }
  });

  test("decode service lifecycle payloads with serviceName", () => {
    for (const [eventName, eventSchema] of serviceLifecycleEvents) {
      const result = Schema.decodeUnknownEither(eventSchema)({
        _tag: eventName,
        eventName,
        ...basePayload,
        serviceName: "web",
      });

      expect(Either.isRight(result)).toBe(true);
      if (Either.isRight(result)) {
        expect(result.right.eventName).toBe(eventName);
        expect(result.right.serviceName).toBe("web");
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
});
