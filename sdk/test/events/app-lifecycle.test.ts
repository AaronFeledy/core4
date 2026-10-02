import { SchemaIssue } from "effect";
import { describe, expect, test } from "bun:test";

import { DateTime, Result, Schema } from "effect";

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

const FIXED_TIMESTAMP = DateTime.makeUnsafe("2026-05-11T07:30:00Z");

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
  ["pre-app-start", Schema.decodeUnknownResult(PreAppStartEvent)],
  ["post-app-start", Schema.decodeUnknownResult(PostAppStartEvent)],
  ["pre-app-stop", Schema.decodeUnknownResult(PreAppStopEvent)],
  ["post-app-stop", Schema.decodeUnknownResult(PostAppStopEvent)],
  ["pre-build", Schema.decodeUnknownResult(PreBuildEvent)],
  ["post-build", Schema.decodeUnknownResult(PostBuildEvent)],
] as const;

const serviceLifecycleEvents = [
  ["pre-service-start", Schema.decodeUnknownResult(PreServiceStartEvent)],
  ["post-service-start", Schema.decodeUnknownResult(PostServiceStartEvent)],
  ["pre-service-stop", Schema.decodeUnknownResult(PreServiceStopEvent)],
  ["post-service-stop", Schema.decodeUnknownResult(PostServiceStopEvent)],
] as const;

describe("app lifecycle event payload schemas", () => {
  test("decode app and build lifecycle payloads with pinned eventName literals", () => {
    for (const [eventName, decode] of appLifecycleEvents) {
      const result = decode({
        _tag: eventName,
        eventName,
        ...basePayload,
      });

      expect(result._tag).toBe("Success");
      if (result._tag === "Success") {
        expect(String(result.success.eventName)).toBe(eventName);
        expect(String(result.success.appRef.id)).toBe("myapp");
        expect(String(result.success.providerId)).toBe("lando");
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

      expect(result._tag).toBe("Success");
      if (result._tag === "Success") {
        expect(String(result.success.eventName)).toBe(eventName);
        expect(String(result.success.serviceName)).toBe("web");
      }
    }
  });

  test("rejects a mismatched eventName with a structured ParseError", () => {
    const result = Schema.decodeUnknownResult(PreAppStartEvent)({
      _tag: "pre-app-start",
      eventName: "post-app-start",
      ...basePayload,
    });

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Schema.isSchemaError(result.failure)).toBe(true);
      const issues = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues;
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some((issue) => (issue.path ?? []).includes("eventName"))).toBe(true);
    }
  });

  test("rejects service lifecycle payloads missing serviceName", () => {
    const result = Schema.decodeUnknownResult(PreServiceStartEvent)({
      _tag: "pre-service-start",
      eventName: "pre-service-start",
      ...basePayload,
    });

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Schema.isSchemaError(result.failure)).toBe(true);
      const issues = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues;
      expect(issues.some((issue) => (issue.path ?? []).includes("serviceName"))).toBe(true);
    }
  });

  test("decodes build step skip payloads with cache reason fields", () => {
    const result = Schema.decodeUnknownResult(BuildStepSkipEvent)({
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

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success.eventName).toBe("build-step-skip");
      expect(result.success.appRef.kind).toBe("scratch");
      expect(result.success.cached).toBe(true);
    }
  });
});
