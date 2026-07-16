import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { EventService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { landoRenderer } from "../../../src/cli/renderer/bundled-renderers.ts";
import { createBufferedRendererIO } from "../../../src/cli/renderer/io.ts";
import { makeJsonRendererLive, renderPlain } from "../../../src/cli/renderer/runtime.ts";
import { EventServiceLive } from "../../../src/services/event-service.ts";
import {
  SUMMARY_FIXTURES,
  TREE_FIXTURES,
  captureSummaryFrame,
  captureTreeFrame,
  diffGolden,
  displayWidth,
  goldenName,
  isGoldenUpdateMode,
  readOrWriteGolden,
  stripAnsi,
  tokenizeAnsi,
  warn,
} from "./visual-qa-harness.ts";

const ESC = String.fromCharCode(27);

// ---------------------------------------------------------------------------
// T1 — tokenizer + primitives
// ---------------------------------------------------------------------------
describe("visual-qa tokenizer", () => {
  test("maps each known SGR code to a readable marker", () => {
    const cases: ReadonlyArray<[string, string]> = [
      [`${ESC}[0m`, "⟨reset⟩"],
      [`${ESC}[1m`, "⟨bold⟩"],
      [`${ESC}[2m`, "⟨dim⟩"],
      [`${ESC}[22m`, "⟨dim-off⟩"],
      [`${ESC}[31m`, "⟨red⟩"],
      [`${ESC}[32m`, "⟨green⟩"],
      [`${ESC}[33m`, "⟨amber⟩"],
      [`${ESC}[36m`, "⟨cyan⟩"],
      [`${ESC}[95m`, "⟨pink⟩"],
    ];
    for (const [code, marker] of cases) {
      expect(tokenizeAnsi(`${code}text${ESC}[0m`)).toBe(`${marker}text⟨reset⟩`);
    }
  });

  test("drops cursor-control escapes and never leaks a raw escape byte", () => {
    const raw = `${ESC}[4A${ESC}[0J${ESC}[1m${ESC}[36m╭─ LANDO OPS ─╮${ESC}[0m`;
    const tokenized = tokenizeAnsi(raw);
    expect(tokenized).toBe("⟨bold⟩⟨cyan⟩╭─ LANDO OPS ─╮⟨reset⟩");
    expect(tokenized).not.toContain(ESC);
  });

  test("labels an unknown SGR code instead of leaking it", () => {
    expect(tokenizeAnsi(`${ESC}[7mx${ESC}[0m`)).toBe("⟨sgr:7⟩x⟨reset⟩");
  });
});

// ---------------------------------------------------------------------------
// S1 — task-tree golden frames
// ---------------------------------------------------------------------------
describe("task-tree visual golden frames", () => {
  for (const fixture of TREE_FIXTURES) {
    for (const columns of fixture.widths) {
      test(`${fixture.id} @ ${columns} cols matches its committed golden`, () => {
        const captured = captureTreeFrame(fixture.events, columns);
        // The golden never contains a raw escape byte (readable in CI diffs).
        expect(captured.tokenized).not.toContain(ESC);
        // Width invariant is asserted on the stripped raw frame, not the tokens.
        for (const line of captured.lines) {
          expect(displayWidth(line), `line over ${columns} cols:\n${line}`).toBeLessThanOrEqual(columns);
        }
        const name = goldenName("tree", fixture.id, columns);
        const golden = readOrWriteGolden(name, captured.tokenized);
        if (captured.tokenized !== golden) {
          throw new Error(diffGolden(name, golden, captured.tokenized, columns));
        }
        expect(captured.tokenized).toBe(golden);
      });
    }
  }

  test("every tree golden frame carries the spaceship-console language", () => {
    const captured = captureTreeFrame(TREE_FIXTURES.find((f) => f.id === "success")?.events ?? [], 100);
    expect(captured.styled).toContain("LANDO OPS");
    expect(captured.styled).toContain("[ONLINE]");
    expect(captured.tokenized).toContain("⟨green⟩");
    expect(captured.tokenized).toContain("⟨pink⟩");
  });

  test("keeps task-tree titles and borders pink around semantic content", () => {
    // Given the live setup task tree with a text-bearing telemetry footer.
    const fixture = TREE_FIXTURES.find((candidate) => candidate.id === "setup-plan");
    const captured = captureTreeFrame(fixture?.events ?? [], 100);
    const lines = captured.tokenized.split("\n");
    const online = lines.find((line) => line.includes("│") && line.includes("[ONLINE]"));
    const footer = lines.find((line) => line.includes("telemetry"));

    // When the frame is styled, then pink borders remain isolated from semantic content colors.
    expect(lines[0]?.startsWith("⟨bold⟩⟨pink⟩╭─ LANDO OPS")).toBe(true);
    expect(online?.startsWith("⟨pink⟩│⟨reset⟩⟨green⟩ ")).toBe(true);
    expect(online?.endsWith("⟨reset⟩⟨pink⟩│⟨reset⟩")).toBe(true);
    expect(footer?.startsWith("⟨pink⟩╰─⟨reset⟩⟨dim⟩⟨pink⟩ ")).toBe(true);
    expect(footer).toContain("⟨dim-off⟩⟨reset⟩⟨pink⟩─");
    expect(footer?.endsWith("╯⟨reset⟩")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// S2 — grouped summary golden frames
// ---------------------------------------------------------------------------
describe("summary visual golden frames", () => {
  for (const fixture of SUMMARY_FIXTURES) {
    for (const columns of fixture.widths) {
      test(`${fixture.id} @ ${columns} cols matches its committed golden`, () => {
        const captured = captureSummaryFrame(fixture.doc, columns);
        expect(captured.tokenized).not.toContain(ESC);
        // Summaries pad every line to the exact width.
        for (const line of captured.lines) {
          expect(displayWidth(line), `line not exactly ${columns} cols:\n${line}`).toBe(columns);
        }
        const name = goldenName("summary", fixture.id, columns);
        const golden = readOrWriteGolden(name, captured.tokenized);
        if (captured.tokenized !== golden) {
          throw new Error(diffGolden(name, golden, captured.tokenized, columns));
        }
        expect(captured.tokenized).toBe(golden);
      });
    }
  }

  test("redaction markers pass through verbatim into the golden", () => {
    const captured = captureSummaryFrame(
      SUMMARY_FIXTURES.find((f) => f.id === "setup-readiness-redaction")?.doc ?? {
        title: "x",
        sections: [],
      },
      100,
    );
    expect(captured.tokenized).toContain("[redacted]");
  });
});

// ---------------------------------------------------------------------------
// S3 — readable diff classifies all four regression classes
// ---------------------------------------------------------------------------
describe("readable golden diff", () => {
  test("classifies a color-token regression", () => {
    const golden = "⟨green⟩│ [ONLINE] app │⟨reset⟩";
    const drifted = "⟨amber⟩│ [ONLINE] app │⟨reset⟩";
    const out = diffGolden("color", golden, drifted, 16);
    expect(out).toContain("color-token");
    expect(out).toContain("ruler:");
  });

  test("classifies a spacing regression", () => {
    const golden = "│ [OK] app     │";
    const drifted = "│ [OK] app  │";
    const out = diffGolden("spacing", golden, drifted, 16);
    expect(out).toContain("spacing");
  });

  test("classifies a truncation regression", () => {
    const golden = "│ a very long label that is cl… │";
    const drifted = "│ a very long label that is clipped here │";
    const out = diffGolden("truncation", golden, drifted, 32);
    expect(out).toContain("truncation");
  });

  test("classifies a wide-character regression", () => {
    const golden = "│ 你好世界 service │";
    const drifted = "│ 你好世 service │";
    const out = diffGolden("wide", golden, drifted, 20);
    expect(out).toContain("wide-character");
  });

  test("reports no regression classes when the frames match", () => {
    const out = diffGolden("same", "a", "a", 4);
    expect(out).toContain("regression classes: none");
  });
});

// ---------------------------------------------------------------------------
// S4 — provider-free pipeline using TestRuntimeProvider + injected events
// ---------------------------------------------------------------------------
describe("provider-free injected-event pipeline", () => {
  test("renders a decorated TTY frame from injected events with TestRuntimeProvider in scope", async () => {
    // TestRuntimeProvider is a pure in-memory provider: no real container
    // runtime, network, or host mutation is reachable from this gate.
    const available = await Effect.runPromise(TestRuntimeProvider.isAvailable);
    expect(available).toBe(true);
    const applied = await Effect.runPromise(
      Effect.scoped(TestRuntimeProvider.apply(undefined as never, undefined as never)),
    );
    expect(applied).toEqual({ changed: false });
    await Effect.runPromise(
      Effect.scoped(TestRuntimeProvider.destroy(undefined as never, undefined as never)),
    );

    const io = createBufferedRendererIO({ isTTY: true, terminalColumns: 100 });
    const events = TREE_FIXTURES.find((f) => f.id === "build-failure")?.events ?? [];
    const program = Effect.gen(function* () {
      const service = yield* EventService;
      for (const event of events) yield* service.publish(event);
      yield* Effect.sleep("20 millis");
    });
    await Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(Layer.provideMerge(landoRenderer.makeEventConsumer(io), EventServiceLive)),
        ),
      ),
    );
    expect(io.stdout()).toContain(ESC); // decorated ANSI in TTY mode
    expect(stripAnsi(io.stdout())).toContain("LANDO OPS");
    expect(stripAnsi(io.stdout())).toContain("[BLOCKED]");
  });
});

// ---------------------------------------------------------------------------
// S5 — machine modes stay undecorated (regression fixtures only)
// ---------------------------------------------------------------------------
describe("undecorated machine-mode regression fixtures", () => {
  const events = TREE_FIXTURES.find((f) => f.id === "build-failure")?.events ?? [];

  test("json renderer stays plain NDJSON with no spaceship styling", async () => {
    const io = createBufferedRendererIO();
    const program = Effect.gen(function* () {
      const service = yield* EventService;
      for (const event of events) yield* service.publish(event);
      yield* Effect.sleep("20 millis");
    });
    await Effect.runPromise(
      Effect.scoped(
        program.pipe(Effect.provide(Layer.provideMerge(makeJsonRendererLive(io), EventServiceLive))),
      ),
    );
    const lines = io.stderrLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect(line).not.toContain("LANDO OPS");
      expect(line).not.toContain("╭─");
      expect(line).not.toContain(ESC);
    }
    expect(io.stdout()).toBe("");
  });

  test("plain non-TTY fallback emits no ANSI and no panel framing", () => {
    const io = createBufferedRendererIO();
    renderPlain(io, [...events, warn("runtime bundle checksum is using a placeholder")]);
    const out = io.stdout();
    expect(out).not.toContain(ESC);
    expect(out).not.toContain("LANDO OPS");
    expect(out).not.toContain("╭─");
    expect(out).toContain("⚠ runtime bundle checksum is using a placeholder");
  });

  test("non-TTY lando renderer degrades to undecorated output", async () => {
    const io = createBufferedRendererIO({ isTTY: false });
    const program = Effect.gen(function* () {
      const service = yield* EventService;
      for (const event of events) yield* service.publish(event);
      yield* Effect.sleep("20 millis");
    });
    await Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(Layer.provideMerge(landoRenderer.makeEventConsumer(io), EventServiceLive)),
        ),
      ),
    );
    expect(io.stdout()).not.toContain(ESC);
    expect(io.stdout()).not.toContain("╭─");
  });
});

// ---------------------------------------------------------------------------
// Guardrail — the gate is never silently regenerating goldens in CI.
// ---------------------------------------------------------------------------
describe("visual-qa gate discipline", () => {
  test("golden update mode is opt-in only", () => {
    expect(isGoldenUpdateMode()).toBe(process.env.LANDO_UPDATE_VISUAL_QA === "1");
  });
});
