import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { PaintBannerEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";

import { DEFAULT_BANNER_RUNTIME_LABEL, formatBanner, paintBanner } from "../../src/cli/oclif/pre-renderer.ts";
import { renderJsonLine, renderPlainLine } from "../../src/cli/renderer/format.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import {
  makeJsonRendererLive,
  makeLandoRendererLive,
  makePlainRendererLive,
} from "../../src/cli/renderer/runtime.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";

const ESC = String.fromCharCode(27);
const ANSI_PREFIX = `${ESC}[`;

const preRendererSource = readFileSync(
  resolve(import.meta.dirname, "../../src/cli/oclif/pre-renderer.ts"),
  "utf8",
);

const collectImportSpecifiers = (source: string): ReadonlyArray<string> => {
  const specifiers: string[] = [];
  // `import ... from "x"` / `import "x"`
  const fromRe = /\bfrom\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(fromRe)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  // `import("x")` and `require("x")`
  const callRe = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(callRe)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  // bare `import "x"`
  const bareRe = /^\s*import\s+["']([^"']+)["']/gm;
  for (const match of source.matchAll(bareRe)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return specifiers;
};

interface FakeStream {
  readonly writes: string[];
  readonly isTTY: boolean;
  readonly write: (chunk: string) => boolean;
}

const makeFakeStream = (isTTY: boolean): FakeStream => {
  const writes: string[] = [];
  return {
    writes,
    isTTY,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  };
};

describe("formatBanner", () => {
  test("renders a single line ending with an ellipsis", () => {
    const banner = formatBanner({ commandId: "app:start" });
    expect(banner.includes("\n")).toBe(false);
    expect(banner.endsWith("…")).toBe(true);
  });

  test("mentions the resolved command id", () => {
    const banner = formatBanner({ commandId: "app:start" });
    expect(banner).toContain("app:start");
  });

  test("mentions the default runtime label", () => {
    const banner = formatBanner({ commandId: "app:start" });
    expect(banner).toContain(DEFAULT_BANNER_RUNTIME_LABEL);
  });

  test("honors an explicit runtime label", () => {
    const banner = formatBanner({ commandId: "meta:doctor", runtime: "podman runtime" });
    expect(banner).toContain("meta:doctor");
    expect(banner).toContain("podman runtime");
  });

  test("output never contains ANSI control sequences (TTY or not)", () => {
    const tty = formatBanner({ commandId: "app:start", isTTY: true });
    const nonTty = formatBanner({ commandId: "app:start", isTTY: false });
    expect(tty.includes(ANSI_PREFIX)).toBe(false);
    expect(nonTty.includes(ANSI_PREFIX)).toBe(false);
  });
});

describe("paintBanner (TTY fixture)", () => {
  test("writes exactly one line to the supplied stream when TTY", () => {
    const stream = makeFakeStream(true);
    const result = paintBanner({ commandId: "app:start", stream });
    expect(result.emitted).toBe(true);
    expect(stream.writes.length).toBe(1);
    const wrote = stream.writes[0];
    if (wrote === undefined) throw new Error("expected one write");
    expect(wrote.endsWith("\n")).toBe(true);
    const lines = wrote.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe(result.banner);
  });

  test("writes exactly one line to the supplied stream when non-TTY", () => {
    const stream = makeFakeStream(false);
    const result = paintBanner({ commandId: "app:start", stream });
    expect(result.emitted).toBe(true);
    expect(stream.writes.length).toBe(1);
    const wrote = stream.writes[0];
    if (wrote === undefined) throw new Error("expected one write");
    expect(wrote.includes(ANSI_PREFIX)).toBe(false);
  });

  test("emits the banner within the cold first-byte budget", () => {
    const stream = makeFakeStream(false);
    const start = performance.now();
    paintBanner({ commandId: "app:start", stream });
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(50);
    expect(stream.writes.length).toBe(1);
  });

  test("is idempotent per call site: re-invoking emits a fresh banner each time", () => {
    const stream = makeFakeStream(false);
    paintBanner({ commandId: "app:start", stream });
    paintBanner({ commandId: "app:start", stream });
    expect(stream.writes.length).toBe(2);
  });
});

describe("pre-renderer module discipline", () => {
  test("the pre-renderer source does not statically import Effect, the Renderer service, OCLIF, or any plugin code", () => {
    const specifiers = collectImportSpecifiers(preRendererSource);
    const forbiddenPrefixes = [
      "effect",
      "@oclif/",
      "@lando/core/cli/renderer",
      "../renderer/",
      "../../runtime/",
      "../../../runtime/",
      "@lando/core/plugins",
      "../../plugins/",
      "@lando/sdk",
    ];
    for (const specifier of specifiers) {
      for (const prefix of forbiddenPrefixes) {
        if (specifier === prefix || specifier.startsWith(`${prefix}/`)) {
          throw new Error(`pre-renderer imports forbidden module "${specifier}" (prefix "${prefix}")`);
        }
        if (specifier === prefix.replace(/\/$/, "")) {
          throw new Error(`pre-renderer imports forbidden module "${specifier}"`);
        }
      }
    }
  });

  test("the pre-renderer source only imports node builtins (or imports nothing at all)", () => {
    const specifiers = collectImportSpecifiers(preRendererSource);
    for (const specifier of specifiers) {
      const isNodeBuiltin = specifier.startsWith("node:");
      if (!isNodeBuiltin) {
        throw new Error(`pre-renderer imports non-builtin module "${specifier}"`);
      }
    }
  });
});

describe("Renderer Layer hand-off for paint.banner", () => {
  const banner = "▲ Starting app:start (using lando runtime)…";

  const buildBannerEvent = (): unknown =>
    Schema.decodeUnknownSync(PaintBannerEvent)({
      _tag: "paint.banner",
      banner,
      timestamp: "2026-05-19T12:00:00.000Z",
    });

  test("plain renderLine returns null for paint.banner (banner already on stdout)", () => {
    const event = buildBannerEvent();
    expect(renderPlainLine(event as never)).toBeNull();
  });

  test("json renderLine returns one NDJSON line for paint.banner", () => {
    const event = buildBannerEvent();
    const line = renderJsonLine(event as never);
    expect(line).not.toBeNull();
    if (line === null) throw new Error("expected JSON line");
    const parsed = JSON.parse(line) as { _tag: string; banner: string };
    expect(parsed._tag).toBe("paint.banner");
    expect(parsed.banner).toBe(banner);
  });

  test("plain Layer consumes paint.banner without re-emitting on stdout", async () => {
    const io = createBufferedRendererIO();
    const program = Effect.gen(function* () {
      const events = yield* EventService;
      yield* events.publish(buildBannerEvent() as never);
      yield* Effect.sleep("20 millis");
    });
    const layer = Layer.provideMerge(makePlainRendererLive(io), EventServiceLive);
    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));

    expect(io.stdout()).toBe("");
    expect(io.stderr()).toBe("");
  });

  test("lando Layer (currently plain-aliased) also consumes paint.banner without re-emitting", async () => {
    const io = createBufferedRendererIO();
    const program = Effect.gen(function* () {
      const events = yield* EventService;
      yield* events.publish(buildBannerEvent() as never);
      yield* Effect.sleep("20 millis");
    });
    const layer = Layer.provideMerge(makeLandoRendererLive(io), EventServiceLive);
    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));

    expect(io.stdout()).toBe("");
    expect(io.stderr()).toBe("");
  });

  test("json Layer emits exactly one NDJSON line for paint.banner on stderr", async () => {
    const io = createBufferedRendererIO();
    const program = Effect.gen(function* () {
      const events = yield* EventService;
      yield* events.publish(buildBannerEvent() as never);
      yield* Effect.sleep("20 millis");
    });
    const layer = Layer.provideMerge(makeJsonRendererLive(io), EventServiceLive);
    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));

    expect(io.stdout()).toBe("");
    const lines = io.stderrLines();
    expect(lines.length).toBe(1);
    const firstLine = lines[0];
    if (firstLine === undefined) throw new Error("expected NDJSON line");
    const parsed = JSON.parse(firstLine) as { _tag: string; banner: string };
    expect(parsed._tag).toBe("paint.banner");
    expect(parsed.banner).toBe(banner);
  });

  test("plain Layer hand-off is one-shot: publishing twice still writes nothing to stdout", async () => {
    const io = createBufferedRendererIO();
    const program = Effect.gen(function* () {
      const events = yield* EventService;
      yield* events.publish(buildBannerEvent() as never);
      yield* events.publish(buildBannerEvent() as never);
      yield* Effect.sleep("20 millis");
    });
    const layer = Layer.provideMerge(makePlainRendererLive(io), EventServiceLive);
    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));

    expect(io.stdout()).toBe("");
  });
});
