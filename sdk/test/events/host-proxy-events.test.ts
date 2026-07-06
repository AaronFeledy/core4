import { describe, expect, test } from "bun:test";
import { DateTime, Schema } from "effect";

import { PostHostProxyCallEvent, PreHostProxyCallEvent } from "../../src/events/host-proxy.ts";
import { LandoEvent } from "../../src/events/union.ts";

const timestamp = DateTime.unsafeMake("2026-07-06T00:00:00.000Z");
const appRef = { kind: "user" as const, id: "demo", root: "/home/u/demo" };
const redactedRequest = {
  kind: "runLando",
  commandId: "app:open",
  argvSummary: ["open", "--print"],
  cwd: "/home/u/demo",
};

describe("host-proxy call events", () => {
  test("pre-host-proxy-call is a member of the LandoEvent union", () => {
    const value = PreHostProxyCallEvent.make({
      app: appRef,
      callId: "call-1",
      request: redactedRequest,
      callerService: "web",
      depth: 0,
      timestamp,
    });
    expect(Schema.is(LandoEvent)(value)).toBe(true);
    expect(value._tag).toBe("pre-host-proxy-call");
  });

  test("post-host-proxy-call carries outcome and is a union member", () => {
    const value = PostHostProxyCallEvent.make({
      app: appRef,
      callId: "call-1",
      request: redactedRequest,
      callerService: "web",
      depth: 0,
      outcome: "success",
      durationMs: 12,
      resultSummary: "opened",
      timestamp,
    });
    expect(Schema.is(LandoEvent)(value)).toBe(true);
    expect(value._tag).toBe("post-host-proxy-call");
    if (value._tag === "post-host-proxy-call") expect(value.outcome).toBe("success");
  });

  test("post-host-proxy-call accepts a failure outcome", () => {
    const value = PostHostProxyCallEvent.make({
      app: appRef,
      callId: "call-2",
      request: { kind: "runLando" },
      callerService: "web",
      depth: 0,
      outcome: "failure",
      failureDetail: "HostProxyCommandNotAllowedError",
      timestamp,
    });
    expect(Schema.is(LandoEvent)(value)).toBe(true);
  });
});
