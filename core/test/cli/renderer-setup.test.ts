import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  type LandoEvent,
  TaskCompleteEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";

import { renderPlainLine } from "../../src/cli/renderer/format.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import { drainRendererSync, renderJson, renderPlain } from "../../src/cli/renderer/runtime.ts";

const fixturePath = resolve(import.meta.dirname, "fixtures/renderer.setup.ndjson");
const fixtureContent = readFileSync(fixturePath, "utf8");

const parseNdjson = (content: string): ReadonlyArray<LandoEvent> => {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => JSON.parse(line) as LandoEvent);
};

const rawEvents = parseNdjson(fixtureContent);

const decodeFixtureEvents = (): ReadonlyArray<LandoEvent> =>
  rawEvents.map((raw) => {
    switch (raw._tag) {
      case "task.tree.start":
        return Schema.decodeUnknownSync(TaskTreeStartEvent)(raw);
      case "task.start":
        return Schema.decodeUnknownSync(TaskStartEvent)(raw);
      case "task.complete":
        return Schema.decodeUnknownSync(TaskCompleteEvent)(raw);
      case "task.tree.complete":
        return Schema.decodeUnknownSync(TaskTreeCompleteEvent)(raw);
      default:
        throw new Error(`unexpected fixture event _tag: ${raw._tag}`);
    }
  });

describe("renderer.setup fixture", () => {
  test("plain renderer formats provider setup steps", () => {
    const io = createBufferedRendererIO();
    renderPlain(io, rawEvents);
    const lines = io.stdoutLines();
    expect(lines[0]).toBe("▼ Setting up Lando runtime (4 services)");
    expect(lines[1]).toContain("[bundle] start: Verify runtime bundle");
    expect(lines[2]).toContain("[bundle] ✓ complete: Verify runtime bundle");
    expect(lines[3]).toContain("[podman] start: Detect Podman");
    expect(lines[4]).toContain("[podman] ✓ complete: Detect Podman");
    expect(lines[5]).toContain("[socket] start: Probe Podman API");
    expect(lines[6]).toContain("[socket] ✓ complete: Probe Podman API");
    expect(lines[7]).toContain("[state] start: Persist setup state");
    expect(lines[8]).toContain("[state] ✓ complete: Persist setup state");
    expect(lines[9]).toContain("▶ Lando runtime ready (4 ✓ · 0 ✗)");
  });

  test("plain renderer snapshot is stable", () => {
    const io = createBufferedRendererIO();
    renderPlain(io, decodeFixtureEvents());
    expect(io.stdout()).toMatchSnapshot();
  });

  test("json renderer snapshot is stable on stderr", () => {
    const io = createBufferedRendererIO();
    renderJson(io, decodeFixtureEvents());
    expect(io.stderr()).toMatchSnapshot();
  });

  test("lando renderer snapshot matches plain renderer (alpha alias)", () => {
    const plainIo = createBufferedRendererIO();
    renderPlain(plainIo, decodeFixtureEvents());

    const landoIo = createBufferedRendererIO();
    drainRendererSync(renderPlainLine, landoIo, "stdout", decodeFixtureEvents());

    expect(landoIo.stdout()).toBe(plainIo.stdout());
    expect(landoIo.stdout()).toMatchSnapshot();
  });

  test("setup event order is tree.start → steps → tree.complete", () => {
    const tags = rawEvents.map((event) => event._tag);
    expect(tags[0]).toBe("task.tree.start");
    expect(tags[tags.length - 1]).toBe("task.tree.complete");
    const taskStartCount = tags.filter((tag) => tag === "task.start").length;
    const taskCompleteCount = tags.filter((tag) => tag === "task.complete").length;
    expect(taskStartCount).toBe(4);
    expect(taskCompleteCount).toBe(4);
  });
});
