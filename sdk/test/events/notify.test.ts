import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { CommandInvocationCorrelation, NotifyDesktopEvent } from "@lando/sdk/events";
import { NotifyConfig } from "@lando/sdk/schema";

describe("NotifyDesktopEvent", () => {
  test("decodes a valid notification", () => {
    const decoded = Schema.decodeUnknownEither(NotifyDesktopEvent)({
      _tag: "notify.desktop",
      title: "Done",
      body: "ok",
      urgency: "success",
    });
    expect(Either.isRight(decoded)).toBe(true);
  });

  test("rejects empty title and overlong body", () => {
    expect(() =>
      Schema.decodeUnknownSync(NotifyDesktopEvent)({ _tag: "notify.desktop", title: "" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(NotifyDesktopEvent)({
        _tag: "notify.desktop",
        title: "x",
        body: "y".repeat(4097),
      }),
    ).toThrow();
  });
});

describe("NotifyConfig", () => {
  test("defaults enabled true, thresholdMs 15000, commands empty", () => {
    const value = Schema.decodeUnknownSync(NotifyConfig)({});
    expect(value.enabled).toBe(true);
    expect(value.thresholdMs).toBe(15_000);
    expect(value.commands).toEqual([]);
  });
});

describe("CommandInvocationCorrelation", () => {
  test("parent is optional", () => {
    const outer = Schema.decodeUnknownSync(CommandInvocationCorrelation)({
      invocationId: "abc",
    });
    expect(outer.parentInvocationId).toBeUndefined();
    const nested = Schema.decodeUnknownSync(CommandInvocationCorrelation)({
      invocationId: "child",
      parentInvocationId: "abc",
    });
    expect(nested.parentInvocationId).toBe("abc");
  });
});
