import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { TaskTreeCompleteEvent, TaskTreeStartEvent } from "@lando/sdk/events";

import {
  createToolingStatusPainter,
  formatToolingStatusLines,
  isToolingTreeParentId,
  toolingNameFromParentId,
} from "../src/tooling-status.ts";

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (text: string): string => text.replace(SGR, "");

describe("tooling live status", () => {
  test("identifies tooling tree parent ids", () => {
    expect(isToolingTreeParentId("tooling:composer")).toBe(true);
    expect(isToolingTreeParentId("app:start")).toBe(false);
    expect(toolingNameFromParentId("tooling:composer")).toBe("composer");
  });

  test("formats a dim footer with the tool name and quiet duration", () => {
    // Given / When
    const [underSecond] = formatToolingStatusLines("composer", 400);
    const [overSecond] = formatToolingStatusLines("composer", 12400);

    // Then
    expect(strip(underSecond ?? "")).toBe("╰─ executing composer  400ms");
    expect(strip(overSecond ?? "")).toBe("╰─ executing composer  12.4s");
  });

  test("starts painting on tooling tree start and clears on complete", async () => {
    // Given
    const footers: Array<ReadonlyArray<string>> = [];
    let cleared = 0;
    const painter = createToolingStatusPainter(() => 0);
    const handle = {
      setFooter: (lines: ReadonlyArray<string>) => {
        footers.push(lines);
      },
      clearFooter: () => {
        cleared += 1;
      },
    };
    const acquire = Effect.succeed({ controller: handle });
    const start = TaskTreeStartEvent.make({
      parentId: "tooling:composer",
      label: "composer",
      children: ["tooling:composer:exec"],
      timestamp: DateTime.unsafeMake("2026-08-27T00:00:00.000Z"),
    });
    const complete = TaskTreeCompleteEvent.make({
      parentId: "tooling:composer",
      succeeded: 1,
      failed: 0,
      durationMs: 0,
      timestamp: DateTime.unsafeMake("2026-08-27T00:00:01.000Z"),
    });

    // When
    const started = await Effect.runPromise(painter.consume(start, acquire));
    const completed = await Effect.runPromise(painter.consume(complete, acquire));
    painter.stop();

    // Then
    expect(started).toBe(true);
    expect(completed).toBe(true);
    expect(footers.length).toBeGreaterThan(0);
    expect(strip(footers[0]?.[0] ?? "")).toContain("executing composer");
    expect(cleared).toBeGreaterThan(0);
  });
});
