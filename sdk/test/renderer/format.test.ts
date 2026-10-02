import { describe, expect, test } from "bun:test";

import { renderJsonLine, renderPlainLine, renderVerboseLine } from "@lando/sdk/renderer";
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

describe("plain task tree header", () => {
  test("uses singular step for one-child task trees", () => {
    expect(
      renderPlainLine({
        _tag: "task.tree.start",
        label: "Global services",
        children: [{}],
      } as unknown as LandoEvent),
    ).toBe("▼ Global services (1 step)");
  });
});

describe("image pull progress presentation", () => {
  const pull = (stream: string, progress: Record<string, unknown> = {}): LandoEvent =>
    ({
      _tag: "image-pull-progress",
      reference: "traefik:v3.3",
      stream,
      ...progress,
    }) as unknown as LandoEvent;

  test("omits routine per-blob and artifact frames from human output", () => {
    for (const stream of [
      "Copying blob sha256:abc123\n",
      "Copying config sha256:ABC123",
      "Starting to pull artifact",
      "Pulling artifact",
      "Artifact pulled successfully\n",
      "Artifact already exists",
    ]) {
      expect(renderPlainLine(pull(stream))).toBeNull();
      expect(renderPlainLine(pull(stream, { current: 1, total: 3 }))).toBeNull();
    }
  });

  test("keeps unexpected status and failure details visible", () => {
    expect(renderPlainLine(pull("Writing manifest to image destination\n"))).toBe(
      "↓ Pulling traefik:v3.3: Writing manifest to image destination",
    );
    expect(renderPlainLine(pull("Error copying blob sha256:abc123: disk full"))).toContain(
      "Error copying blob sha256:abc123: disk full",
    );
    expect(renderPlainLine(pull("Copying blob sha256:abc123 failed"))).toContain("failed");
  });

  test("keeps the full routine event in JSON and verbose output", () => {
    const event = pull("Copying blob sha256:abc123\n", { current: 1, total: 3 });
    const json = renderJsonLine(event);
    expect(json).not.toBeNull();
    expect(JSON.parse(json ?? "").payload).toMatchObject({
      reference: "traefik:v3.3",
      stream: "Copying blob sha256:abc123\n",
      current: 1,
      total: 3,
    });
    const verbose = renderVerboseLine(event);
    expect(verbose).toContain("Copying blob sha256:abc123\\n");
    expect(verbose).toContain('"current":1');
  });
});
