import { describe, expect, test } from "bun:test";

import * as events from "@lando/sdk/events";

const tunnelKeys = [
  "_tag",
  "eventName",
  "app",
  "provider",
  "sessionId",
  "targetSummary",
  "detached",
  "publicUrlSummary",
  "timestamp",
  "outcome",
  "failureDetail",
  "durationMs",
] as const;
const syncKeys = [
  "_tag",
  "eventName",
  "remote",
  "env",
  "datasets",
  "timestamp",
  "outcome",
  "failureDetail",
  "durationMs",
] as const;
const datasetKeys = [
  "_tag",
  "eventName",
  "remote",
  "env",
  "dataset",
  "timestamp",
  "outcome",
  "failureDetail",
  "durationMs",
] as const;

const fieldOrders = [
  ["PostTunnelStartEvent", events.PostTunnelStartEvent, tunnelKeys],
  ["PostTunnelStopEvent", events.PostTunnelStopEvent, tunnelKeys],
  ["PostPullEvent", events.PostPullEvent, syncKeys],
  ["PostPushEvent", events.PostPushEvent, syncKeys],
  ["PostDatasetFetchEvent", events.PostDatasetFetchEvent, datasetKeys],
  ["PostDatasetApplyEvent", events.PostDatasetApplyEvent, datasetKeys],
  ["PostDatasetCaptureEvent", events.PostDatasetCaptureEvent, datasetKeys],
  ["PostDatasetSendEvent", events.PostDatasetSendEvent, datasetKeys],
  [
    "PostHttpCallEvent",
    events.PostHttpCallEvent,
    [
      "_tag",
      "eventName",
      "urlOrigin",
      "method",
      "status",
      "callerId",
      "onBehalfOf",
      "outcome",
      "durationMs",
      "failureDetail",
      "timestamp",
    ],
  ],
  [
    "PostMcpCallEvent",
    events.PostMcpCallEvent,
    [
      "_tag",
      "eventName",
      "toolId",
      "commandId",
      "appRef",
      "outcome",
      "durationMs",
      "failureDetail",
      "timestamp",
    ],
  ],
] as const;

describe("post-event outcome fields", () => {
  test.each(fieldOrders)("preserves %s field order when inspecting the schema", (_name, schema, expected) => {
    // Given / When
    const keys = Object.keys(schema.fields);
    // Then
    expect(keys).toEqual([...expected]);
  });

  test.each(fieldOrders)("preserves %s outcomes when inspecting the schema", (_name, schema) => {
    // Given / When
    const outcomes = schema.fields.outcome.literals;
    // Then
    expect([...outcomes]).toEqual(["success", "failure"]);
  });
});
