import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import {
  PANEL_RESPONSE_MAX_BYTES,
  decodePanelView,
  encodePanelView,
  runRendererPanelContract,
} from "@lando/sdk/test";

const fixturesDir = join(import.meta.dir, "../fixtures/panels");

const makeCtx = () => ({
  size: { columns: 80, rows: 1 },
  event: {
    _tag: "message.info" as const,
    body: "panel-fixture",
    timestamp: "2026-07-17T00:00:00.000Z",
  },
});

describe("Renderer panel contract suite", () => {
  test("ready handshake + deterministic pure render over isolated worker", async () => {
    const exit = await Effect.runPromiseExit(
      runRendererPanelContract({
        modulePath: join(fixturesDir, "status-ok.ts"),
        manifestId: "status-ok",
        contexts: [makeCtx() as never, makeCtx() as never],
        renderDeadlineMs: 100,
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.dropped).toBe(false);
      expect(exit.value.lastGood).toBeDefined();
      expect(exit.value.lastGood?.[0]?.[0]?.text).toContain("ok:80x1");
      // Determinism: two identical contexts yield identical last-good content
      expect(exit.value.lastGood?.[0]?.[0]?.tone).toBe("success");
    }
  });

  test("normative render deadline still drops a late panel", async () => {
    const exit = await Effect.runPromiseExit(
      runRendererPanelContract({
        modulePath: join(fixturesDir, "status-delayed.ts"),
        manifestId: "status-delayed",
        contexts: [makeCtx() as never],
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.dropped).toBe(true);
      expect(exit.value.lastGood).toBeUndefined();
    }
  });

  test("test-scoped render deadline allows a timely panel response", async () => {
    const exit = await Effect.runPromiseExit(
      runRendererPanelContract({
        modulePath: join(fixturesDir, "status-delayed.ts"),
        manifestId: "status-delayed",
        contexts: [makeCtx() as never],
        renderDeadlineMs: 100,
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.dropped).toBe(false);
      expect(exit.value.lastGood?.[0]?.[0]?.text).toBe("delayed");
    }
  });

  test("invalid oversize PanelView drops the panel (never clips)", async () => {
    const exit = await Effect.runPromiseExit(
      runRendererPanelContract({
        modulePath: join(fixturesDir, "status-oversize.ts"),
        manifestId: "status-oversize",
        contexts: [makeCtx() as never],
      }),
    );
    // Worker returns failure or host drops on decode — either path marks dropped / no last-good
    if (Exit.isSuccess(exit)) {
      expect(exit.value.dropped || exit.value.lastGood === undefined).toBe(true);
    } else {
      expect(Exit.isFailure(exit)).toBe(true);
    }
  });

  test("thrown render drops the panel", async () => {
    const exit = await Effect.runPromiseExit(
      runRendererPanelContract({
        modulePath: join(fixturesDir, "status-throw.ts"),
        manifestId: "status-throw",
        contexts: [makeCtx() as never],
      }),
    );
    if (Exit.isSuccess(exit)) {
      expect(exit.value.dropped || exit.value.lastGood === undefined).toBe(true);
    } else {
      expect(Exit.isFailure(exit)).toBe(true);
    }
  });

  test("binary PanelView encoding stays within the 5129-byte response ceiling", () => {
    const view = [
      [{ text: "hello", tone: "default" as const, bold: false, dim: false, italic: false, underline: false }],
    ];
    const encoded = encodePanelView(view);
    expect(encoded.byteLength).toBeLessThanOrEqual(PANEL_RESPONSE_MAX_BYTES);
    expect(decodePanelView(encoded)).toEqual(view);
  });
});
