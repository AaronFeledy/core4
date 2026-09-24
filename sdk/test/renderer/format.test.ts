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

describe("plain image pull progress", () => {
  const pull = (stream: string, progress: Record<string, unknown> = {}): LandoEvent =>
    ({
      _tag: "image-pull-progress",
      reference: "traefik:v3.3",
      stream,
      ...progress,
    }) as unknown as LandoEvent;

  test("shows blob identity on one line when Podman includes a trailing newline", () => {
    expect(renderPlainLine(pull("Copying blob sha256:abc123\n"))).toBe(
      "↓ Pulling traefik:v3.3: Copying blob sha256:abc123",
    );
  });

  test("omits repeated identity-free per-blob status lines", () => {
    expect(renderPlainLine(pull("Starting to pull artifact"))).toBeNull();
    expect(renderPlainLine(pull("Pulling artifact"))).toBeNull();
    expect(renderPlainLine(pull("Artifact pulled successfully\n"))).toBeNull();
    expect(renderPlainLine(pull("Artifact already exists"))).toBeNull();
  });

  test("keeps numeric progress and other pull stages visible", () => {
    expect(renderPlainLine(pull("Pulling artifact", { current: 1, total: 3 }))).toBe(
      "↓ Pulling traefik:v3.3: Pulling artifact (1/3)",
    );
    expect(renderPlainLine(pull("Starting to pull artifact", { current: 1, total: 3 }))).toBe(
      "↓ Pulling traefik:v3.3: Starting to pull artifact (1/3)",
    );
    expect(renderPlainLine(pull("Writing manifest to image destination\n"))).toBe(
      "↓ Pulling traefik:v3.3: Writing manifest to image destination",
    );
  });
});
