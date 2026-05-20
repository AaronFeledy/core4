import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { MessageErrorEvent, MessageInfoEvent, MessageWarnEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";

import { renderJsonLine, renderPlainLine } from "../../src/cli/renderer/format.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import {
  makeJsonRendererLive,
  makeLandoRendererLive,
  makePlainRendererLive,
} from "../../src/cli/renderer/runtime.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";

const fixedTimestamp = "2026-05-19T12:00:00.000Z";

const infoEvent = Schema.decodeUnknownSync(MessageInfoEvent)({
  _tag: "message.info",
  body: "fetched 3 plugins",
  timestamp: fixedTimestamp,
});

const warnEvent = Schema.decodeUnknownSync(MessageWarnEvent)({
  _tag: "message.warn",
  body: "Deprecated: services.web.via (since 4.0.0; remove in 5.0.0). Use services.web.runtime.",
  timestamp: fixedTimestamp,
});

const errorEventWithRemediation = Schema.decodeUnknownSync(MessageErrorEvent)({
  _tag: "message.error",
  body: "Failed to load Landofile",
  remediation: "Run `lando config` to see the parsed config.",
  timestamp: fixedTimestamp,
});

const errorEventWithoutRemediation = Schema.decodeUnknownSync(MessageErrorEvent)({
  _tag: "message.error",
  body: "Plugin trust check failed",
  timestamp: fixedTimestamp,
});

describe("plain renderer: message events", () => {
  test("renders message.info with info glyph and body", () => {
    expect(renderPlainLine(infoEvent)).toBe("ℹ fetched 3 plugins");
  });

  test("renders message.warn with warn glyph and body", () => {
    expect(renderPlainLine(warnEvent)).toBe(
      "⚠ Deprecated: services.web.via (since 4.0.0; remove in 5.0.0). Use services.web.runtime.",
    );
  });

  test("renders message.error with fail glyph and indented remediation", () => {
    expect(renderPlainLine(errorEventWithRemediation)).toBe(
      "✗ Failed to load Landofile\n  ↳ Run `lando config` to see the parsed config.",
    );
  });

  test("renders message.error without remediation as a single line", () => {
    expect(renderPlainLine(errorEventWithoutRemediation)).toBe("✗ Plugin trust check failed");
  });

  test("plain renderer output never includes ANSI control sequences", () => {
    const lines = [infoEvent, warnEvent, errorEventWithRemediation, errorEventWithoutRemediation]
      .map((event) => renderPlainLine(event) ?? "")
      .join("\n");
    const escapeChar = String.fromCharCode(27);
    expect(lines.includes(`${escapeChar}[`)).toBe(false);
  });
});

describe("json renderer: message events", () => {
  test("renders message.info as stable JSON with _tag first", () => {
    const line = renderJsonLine(infoEvent);
    expect(line).not.toBeNull();
    if (line === null) throw new Error("expected JSON line");
    const parsed = JSON.parse(line) as { _tag: string; body: string; timestamp: string };
    expect(parsed._tag).toBe("message.info");
    expect(parsed.body).toBe("fetched 3 plugins");
    expect(parsed.timestamp).toBe(fixedTimestamp);
    expect(line.startsWith('{"_tag":"message.info"')).toBe(true);
  });

  test("renders message.warn as stable JSON", () => {
    const line = renderJsonLine(warnEvent);
    expect(line).not.toBeNull();
    if (line === null) throw new Error("expected JSON line");
    const parsed = JSON.parse(line) as { _tag: string; body: string };
    expect(parsed._tag).toBe("message.warn");
    expect(parsed.body).toContain("Deprecated");
  });

  test("renders message.error with remediation field preserved", () => {
    const line = renderJsonLine(errorEventWithRemediation);
    expect(line).not.toBeNull();
    if (line === null) throw new Error("expected JSON line");
    const parsed = JSON.parse(line) as { _tag: string; body: string; remediation: string };
    expect(parsed._tag).toBe("message.error");
    expect(parsed.body).toBe("Failed to load Landofile");
    expect(parsed.remediation).toBe("Run `lando config` to see the parsed config.");
  });

  test("renders message.error without remediation as JSON missing the field", () => {
    const line = renderJsonLine(errorEventWithoutRemediation);
    expect(line).not.toBeNull();
    if (line === null) throw new Error("expected JSON line");
    const parsed = JSON.parse(line) as { _tag: string; body: string; remediation?: string };
    expect(parsed._tag).toBe("message.error");
    expect(parsed.body).toBe("Plugin trust check failed");
    expect(Object.hasOwn(parsed, "remediation")).toBe(false);
  });
});

describe("lando renderer: message events (currently plain-aliased)", () => {
  test("makeLandoRendererLive renders message events to stdout via the plain formatter", async () => {
    const io = createBufferedRendererIO();
    const program = Effect.gen(function* () {
      const events = yield* EventService;
      yield* events.publish(infoEvent);
      yield* events.publish(warnEvent);
      yield* events.publish(errorEventWithRemediation);
      yield* Effect.sleep("20 millis");
    });
    const layer = Layer.provideMerge(makeLandoRendererLive(io), EventServiceLive);
    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));

    const lines = io.stdoutLines();
    expect(lines).toEqual([
      "ℹ fetched 3 plugins",
      "⚠ Deprecated: services.web.via (since 4.0.0; remove in 5.0.0). Use services.web.runtime.",
      "✗ Failed to load Landofile",
      "  ↳ Run `lando config` to see the parsed config.",
    ]);
    expect(io.stderr()).toBe("");
  });
});

describe("plain renderer Layer: message events through EventService", () => {
  test("publish/subscribe path writes one stdout line per message event", async () => {
    const io = createBufferedRendererIO();
    const program = Effect.gen(function* () {
      const events = yield* EventService;
      yield* events.publish(infoEvent);
      yield* events.publish(warnEvent);
      yield* events.publish(errorEventWithoutRemediation);
      yield* Effect.sleep("20 millis");
    });
    const layer = Layer.provideMerge(makePlainRendererLive(io), EventServiceLive);
    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));

    const lines = io.stdoutLines();
    expect(lines).toEqual([
      "ℹ fetched 3 plugins",
      "⚠ Deprecated: services.web.via (since 4.0.0; remove in 5.0.0). Use services.web.runtime.",
      "✗ Plugin trust check failed",
    ]);
  });
});

describe("json renderer Layer: message events through EventService", () => {
  test("publish/subscribe path writes one stderr NDJSON line per message event", async () => {
    const io = createBufferedRendererIO();
    const program = Effect.gen(function* () {
      const events = yield* EventService;
      yield* events.publish(infoEvent);
      yield* events.publish(warnEvent);
      yield* events.publish(errorEventWithRemediation);
      yield* Effect.sleep("20 millis");
    });
    const layer = Layer.provideMerge(makeJsonRendererLive(io), EventServiceLive);
    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));

    expect(io.stdout()).toBe("");
    const lines = io.stderrLines();
    expect(lines.length).toBe(3);
    const tags = lines.map((line) => (JSON.parse(line) as { _tag: string })._tag);
    expect(tags).toEqual(["message.info", "message.warn", "message.error"]);
    const errorLine = lines[2];
    if (errorLine === undefined) throw new Error("missing error line");
    const parsed = JSON.parse(errorLine) as {
      _tag: string;
      body: string;
      remediation: string;
    };
    expect(parsed.remediation).toBe("Run `lando config` to see the parsed config.");
  });
});

describe("exit-code contract: message events do not mutate process.exitCode", () => {
  test("publishing info/warn/error on a successful command leaves process.exitCode unchanged from its prior value", async () => {
    const io = createBufferedRendererIO();
    const sentinel = 42;
    const previousExitCode = process.exitCode;
    process.exitCode = sentinel;
    try {
      const program = Effect.gen(function* () {
        const events = yield* EventService;
        yield* events.publish(infoEvent);
        yield* events.publish(warnEvent);
        yield* events.publish(errorEventWithRemediation);
        yield* Effect.sleep("20 millis");
        return 0;
      });
      const layer = Layer.provideMerge(makePlainRendererLive(io), EventServiceLive);
      const result = await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));
      expect(result).toBe(0);
      expect(process.exitCode).toBe(sentinel);
    } finally {
      process.exitCode = previousExitCode ?? 0;
    }
  });
});
