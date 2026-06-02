import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { MessageInfoEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";

import { RENDERER_MODES, isRendererMode, resolveRendererMode } from "../../src/cli/renderer-selection.ts";
import { renderVerboseLine } from "../../src/cli/renderer/format.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import { makeVerboseRendererLive } from "../../src/cli/renderer/runtime.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";

const fixedTimestamp = "2026-05-19T12:00:00.000Z";

const infoEvent = Schema.decodeUnknownSync(MessageInfoEvent)({
  _tag: "message.info",
  body: "fetched 3 plugins",
  timestamp: fixedTimestamp,
});

describe("verbose renderer registration (selection)", () => {
  test("verbose is a registered renderer mode alongside lando, json, plain", () => {
    expect(RENDERER_MODES).toContain("verbose");
    expect(isRendererMode("verbose")).toBe(true);
  });

  test("--renderer=verbose resolves to mode=verbose from the flag source", () => {
    const result = resolveRendererMode({ argv: ["--renderer=verbose"] });
    expect(result.mode).toBe("verbose");
    expect(result.source).toBe("flag");
  });

  test("flag verbose wins over env and config (flag > env > config > default)", () => {
    const result = resolveRendererMode({
      argv: ["--renderer=verbose"],
      env: { LANDO_RENDERER: "json" },
      configValue: "plain",
    });
    expect(result.mode).toBe("verbose");
    expect(result.source).toBe("flag");
  });

  test("LANDO_RENDERER=verbose resolves from the env source when no flag", () => {
    const result = resolveRendererMode({ env: { LANDO_RENDERER: "verbose" } });
    expect(result.mode).toBe("verbose");
    expect(result.source).toBe("env");
  });

  test("config verbose resolves from the config source when no flag/env", () => {
    const result = resolveRendererMode({ configValue: "verbose" });
    expect(result.mode).toBe("verbose");
    expect(result.source).toBe("config");
  });

  test("default remains lando, not verbose", () => {
    const result = resolveRendererMode({});
    expect(result.mode).toBe("lando");
    expect(result.source).toBe("default");
  });
});

describe("renderVerboseLine — human line + full event payload", () => {
  test("renderable event: keeps the human-readable line and appends the full payload trace", () => {
    const line = renderVerboseLine(infoEvent);
    // Human-readable head retained from the plain/lando formatting.
    expect(line).toContain("ℹ fetched 3 plugins");
    // Full event payload appended as a trace so debugging users see every field.
    expect(line).toContain('"_tag":"message.info"');
    expect(line).toContain('"body":"fetched 3 plugins"');
    expect(line).toContain(`"timestamp":"${fixedTimestamp}"`);
  });

  test("non-renderable event still emits its full payload (every published event is traced)", () => {
    const logLine = Schema.decodeUnknownSync(
      Schema.Struct({
        _tag: Schema.Literal("log.line"),
        line: Schema.String,
        timestamp: Schema.String,
      }),
    )({ _tag: "log.line", line: "raw trace", timestamp: fixedTimestamp });
    const line = renderVerboseLine(logLine as unknown as Parameters<typeof renderVerboseLine>[0]);
    expect(line).toContain("log.line");
    expect(line).toContain('"line":"raw trace"');
  });
});

describe("makeVerboseRendererLive — Layer through EventService", () => {
  test("publishes verbose lines to stdout including the full payload trace", async () => {
    const io = createBufferedRendererIO();
    const program = Effect.gen(function* () {
      const events = yield* EventService;
      yield* events.publish(infoEvent);
      yield* Effect.sleep("20 millis");
    });
    const layer = Layer.provideMerge(makeVerboseRendererLive(io), EventServiceLive);
    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));

    const stdout = io.stdout();
    expect(stdout).toContain("ℹ fetched 3 plugins");
    expect(stdout).toContain('"_tag":"message.info"');
    expect(io.stderr()).toBe("");
  });
});
