import { describe, expect, test } from "bun:test";

import { renderPlainLine } from "@lando/sdk/renderer";
import type { LandoEvent } from "@lando/sdk/services";

const logLine = (fields: Record<string, unknown>): LandoEvent =>
  ({ _tag: "log.line", timestamp: "2026-05-19T12:00:00.000Z", ...fields }) as unknown as LandoEvent;

describe("renderPlainLine — defensive log.line passthrough", () => {
  test("renders the line field when a log.line event supplies it", () => {
    // Given
    const event = logLine({ line: "listening on :3000" });

    // When
    const rendered = renderPlainLine(event);

    // Then
    expect(rendered).toBe("listening on :3000");
  });

  test("falls back to the message field when line is absent", () => {
    // Given
    const event = logLine({ message: "server booted" });

    // When
    const rendered = renderPlainLine(event);

    // Then
    expect(rendered).toBe("server booted");
  });

  test("returns an empty passthrough line when both fields are absent", () => {
    // Given
    const event = logLine({});

    // When
    const rendered = renderPlainLine(event);

    // Then
    expect(rendered).toBe("");
  });
});
