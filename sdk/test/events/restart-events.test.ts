import { expect, test } from "bun:test";
import { Schema } from "effect";

import * as events from "@lando/sdk/events";

const start = Schema.decodeUnknownSync(events.PreStartEvent)({
  _tag: "pre-start",
  scope: "app",
  app: { kind: "user", id: "app", root: "/app" },
  plan: {
    id: "app",
    name: "app",
    slug: "app",
    root: "/app",
    provider: "lando",
    services: {},
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata: { resolvedAt: "2026-05-11T07:30:00Z", source: "/app/.lando.yml", runtime: 4 },
    extensions: {},
  },
  triggeredBy: "app:restart",
  timestamp: "2026-05-11T07:30:00Z",
});

test("pre-restart mirrors the pre-start payload and round-trips through LandoEvent", () => {
  // Given
  expect(events).toHaveProperty("PreRestartEvent");
  const { _tag, ...payload } = start;
  // When
  const event = events.PreRestartEvent.make(payload);
  const wire = Schema.encodeSync(events.PreRestartEvent)(event);
  // Then
  expect(event._tag).toBe("pre-restart");
  expect(Object.keys(events.PreStartEvent.fields).every((key) => key in events.PreRestartEvent.fields)).toBe(
    true,
  );
  expect(events.PreRestartEvent.fields).toHaveProperty("services");
  expect(Schema.decodeUnknownSync(events.LandoEvent)(wire)).toEqual(event);
  expect(wire).not.toHaveProperty("services");
});

test("pre-restart carries selected services when present", () => {
  const { _tag, ...payload } = start;
  const event = events.PreRestartEvent.make({ ...payload, services: ["redis"] });
  const wire = Schema.encodeSync(events.PreRestartEvent)(event);
  expect(Schema.decodeUnknownSync(events.LandoEvent)(wire)).toEqual(event);
  expect(wire).toMatchObject({ services: ["redis"] });
});

test("post-restart mirrors the post-start payload and round-trips through LandoEvent", () => {
  // Given
  expect(events).toHaveProperty("PostRestartEvent");
  const { _tag, triggeredBy, ...payload } = start;
  // When
  const event = events.PostRestartEvent.make(payload);
  const wire = Schema.encodeSync(events.PostRestartEvent)(event);
  // Then
  expect(event._tag).toBe("post-restart");
  expect(
    Object.keys(events.PostStartEvent.fields).every((key) => key in events.PostRestartEvent.fields),
  ).toBe(true);
  expect(events.PostRestartEvent.fields).toHaveProperty("services");
  expect(Schema.decodeUnknownSync(events.LandoEvent)(wire)).toEqual(event);
  expect(wire).not.toHaveProperty("services");
});
