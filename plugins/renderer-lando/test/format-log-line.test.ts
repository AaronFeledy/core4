/**
 * Defensive `log.line` passthrough.
 *
 * `log.line` is not a published `LandoEvent` member today. The renderer still
 * commits any `log.line`-tagged event to scrollback rather than dropping it, so
 * the split-footer substrate carries it if/when an emitter is added.
 */

import { describe, expect, test } from "bun:test";

import type { LandoEvent } from "@lando/sdk/services";

import { renderPlainLine } from "../src/format.ts";

const logLine = (fields: Record<string, unknown>): LandoEvent =>
  ({ _tag: "log.line", timestamp: "2026-05-19T12:00:00.000Z", ...fields }) as unknown as LandoEvent;

describe("renderPlainLine — defensive log.line passthrough", () => {
  test("renders the `line` field of a log.line event", () => {
    expect(renderPlainLine(logLine({ line: "listening on :3000" }))).toBe("listening on :3000");
  });

  test("falls back to the `message` field when `line` is absent", () => {
    expect(renderPlainLine(logLine({ message: "server booted" }))).toBe("server booted");
  });

  test("yields an empty passthrough line (not null) when neither field is present", () => {
    expect(renderPlainLine(logLine({}))).toBe("");
  });
});
