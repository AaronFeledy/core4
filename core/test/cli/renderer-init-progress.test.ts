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

const fixturePath = resolve(import.meta.dirname, "fixtures/renderer.init-progress.ndjson");
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

describe("renderer.init-progress fixture", () => {
  test("plain renderer formats render + postinit tasks", () => {
    const io = createBufferedRendererIO();
    renderPlain(io, rawEvents);
    const lines = io.stdoutLines();
    expect(lines[0]).toBe("▼ Initialize mvp (2 services)");
    expect(lines[1]).toContain("[render] start: Render recipe files (4)");
    expect(lines[2]).toContain("[render] ✓ complete: Rendered 4 files");
    expect(lines[3]).toContain("[postinit] start: Run post-init actions (2)");
    expect(lines[4]).toContain("[postinit] ✓ complete: Ran 2 actions");
    expect(lines[5]).toContain("▶ Initialized mvp (2 ✓ · 0 ✗)");
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

  test("init progress event order is tree.start → render → postinit → tree.complete", () => {
    const tags = rawEvents.map((event) => event._tag);
    expect(tags[0]).toBe("task.tree.start");
    expect(tags[tags.length - 1]).toBe("task.tree.complete");

    const renderStart = tags.indexOf("task.start");
    const renderComplete = tags.indexOf("task.complete");
    const postinitStart = tags.lastIndexOf("task.start");
    const postinitComplete = tags.lastIndexOf("task.complete");

    expect(renderStart).toBeGreaterThan(0);
    expect(renderComplete).toBeGreaterThan(renderStart);
    expect(postinitStart).toBeGreaterThan(renderComplete);
    expect(postinitComplete).toBeGreaterThan(postinitStart);
  });
});
