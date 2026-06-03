import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { Renderer } from "@lando/sdk/services";

import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import {
  makeJsonRenderer,
  makeJsonRendererServiceLive,
  makeLandoRenderer,
  makeLandoRendererServiceLive,
  makePlainRenderer,
  makePlainRendererServiceLive,
  makeVerboseRenderer,
  makeVerboseRendererServiceLive,
} from "../../src/cli/renderer/runtime.ts";

const firstLine = (lines: ReadonlyArray<string>): string => {
  const value = lines[0];
  if (value === undefined) throw new Error("expected at least one line");
  return value;
};

describe("Renderer message contract: plain", () => {
  test("reports the plain id", () => {
    expect(makePlainRenderer(createBufferedRendererIO()).id).toBe("plain");
  });

  test("message.info writes the info glyph + body to stdout", () => {
    const io = createBufferedRendererIO();
    Effect.runSync(makePlainRenderer(io).message.info("fetched 3 plugins"));
    expect(io.stdoutLines()).toEqual(["ℹ fetched 3 plugins"]);
    expect(io.stderr()).toBe("");
  });

  test("message.warn writes the warn glyph + body to stdout", () => {
    const io = createBufferedRendererIO();
    Effect.runSync(makePlainRenderer(io).message.warn("deprecated key"));
    expect(io.stdoutLines()).toEqual(["⚠ deprecated key"]);
  });

  test("message.error with remediation writes two indented stdout lines", () => {
    const io = createBufferedRendererIO();
    Effect.runSync(makePlainRenderer(io).message.error("Failed to load Landofile", "Run `lando config`."));
    expect(io.stdoutLines()).toEqual(["✗ Failed to load Landofile", "  ↳ Run `lando config`."]);
  });

  test("message.error without remediation writes a single stdout line", () => {
    const io = createBufferedRendererIO();
    Effect.runSync(makePlainRenderer(io).message.error("Plugin trust check failed"));
    expect(io.stdoutLines()).toEqual(["✗ Plugin trust check failed"]);
  });

  test("plain message output never includes ANSI control sequences", () => {
    const io = createBufferedRendererIO();
    const renderer = makePlainRenderer(io);
    Effect.runSync(renderer.message.info("a"));
    Effect.runSync(renderer.message.warn("b"));
    Effect.runSync(renderer.message.error("c", "d"));
    const escapeChar = String.fromCharCode(27);
    expect(io.stdout().includes(`${escapeChar}[`)).toBe(false);
  });
});

describe("Renderer message contract: lando (plain-aliased)", () => {
  test("reports the lando id", () => {
    expect(makeLandoRenderer(createBufferedRendererIO()).id).toBe("lando");
  });

  test("renders each severity to stdout via the plain formatter", () => {
    const io = createBufferedRendererIO();
    const renderer = makeLandoRenderer(io);
    Effect.runSync(renderer.message.info("a"));
    Effect.runSync(renderer.message.warn("b"));
    Effect.runSync(renderer.message.error("c", "fix"));
    expect(io.stdoutLines()).toEqual(["ℹ a", "⚠ b", "✗ c", "  ↳ fix"]);
    expect(io.stderr()).toBe("");
  });
});

describe("Renderer message contract: json (stderr NDJSON)", () => {
  test("reports the json id", () => {
    expect(makeJsonRenderer(createBufferedRendererIO()).id).toBe("json");
  });

  test("message.info writes a stable NDJSON line to stderr with _tag first", () => {
    const io = createBufferedRendererIO();
    Effect.runSync(makeJsonRenderer(io).message.info("fetched 3 plugins"));
    expect(io.stdout()).toBe("");
    const lines = io.stderrLines();
    expect(lines.length).toBe(1);
    const line = firstLine(lines);
    expect(line.startsWith('{"_tag":"message.info"')).toBe(true);
    const parsed = JSON.parse(line) as { _tag: string; body: string; timestamp: string };
    expect(parsed._tag).toBe("message.info");
    expect(parsed.body).toBe("fetched 3 plugins");
    expect(typeof parsed.timestamp).toBe("string");
  });

  test("message.warn writes a message.warn NDJSON line", () => {
    const io = createBufferedRendererIO();
    Effect.runSync(makeJsonRenderer(io).message.warn("deprecated key"));
    const parsed = JSON.parse(firstLine(io.stderrLines())) as { _tag: string; body: string };
    expect(parsed._tag).toBe("message.warn");
    expect(parsed.body).toBe("deprecated key");
  });

  test("message.error with remediation preserves the remediation field", () => {
    const io = createBufferedRendererIO();
    Effect.runSync(makeJsonRenderer(io).message.error("boom", "do x"));
    const parsed = JSON.parse(firstLine(io.stderrLines())) as {
      _tag: string;
      body: string;
      remediation: string;
    };
    expect(parsed._tag).toBe("message.error");
    expect(parsed.body).toBe("boom");
    expect(parsed.remediation).toBe("do x");
  });

  test("message.error without remediation omits the field", () => {
    const io = createBufferedRendererIO();
    Effect.runSync(makeJsonRenderer(io).message.error("boom"));
    const parsed = JSON.parse(firstLine(io.stderrLines())) as { remediation?: string };
    expect(Object.hasOwn(parsed, "remediation")).toBe(false);
  });
});

describe("Renderer message contract: verbose (stdout human + payload trace)", () => {
  test("reports the verbose id", () => {
    expect(makeVerboseRenderer(createBufferedRendererIO()).id).toBe("verbose");
  });

  test("message.info writes the human line plus a JSON payload trace", () => {
    const io = createBufferedRendererIO();
    Effect.runSync(makeVerboseRenderer(io).message.info("hey"));
    const lines = io.stdoutLines();
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe("ℹ hey");
    const trace = lines[1];
    if (trace === undefined) throw new Error("expected payload trace line");
    const payload = trace.replace(/^\s*⋯\s*/, "");
    const parsed = JSON.parse(payload) as { _tag: string; body: string };
    expect(parsed._tag).toBe("message.info");
    expect(parsed.body).toBe("hey");
    expect(io.stderr()).toBe("");
  });

  test("message.warn writes the human line plus a message.warn payload trace", () => {
    const io = createBufferedRendererIO();
    Effect.runSync(makeVerboseRenderer(io).message.warn("deprecated key"));
    const lines = io.stdoutLines();
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe("⚠ deprecated key");
    const trace = lines[1];
    if (trace === undefined) throw new Error("expected payload trace line");
    const parsed = JSON.parse(trace.replace(/^\s*⋯\s*/, "")) as { _tag: string; body: string };
    expect(parsed._tag).toBe("message.warn");
    expect(parsed.body).toBe("deprecated key");
  });

  test("message.error trace carries the remediation field", () => {
    const io = createBufferedRendererIO();
    Effect.runSync(makeVerboseRenderer(io).message.error("boom", "do x"));
    const lines = io.stdoutLines();
    expect(lines[0]).toBe("✗ boom");
    expect(lines[1]).toBe("  ↳ do x");
    const trace = lines.find((line) => line.includes("⋯"));
    if (trace === undefined) throw new Error("expected payload trace line");
    const parsed = JSON.parse(trace.replace(/^\s*⋯\s*/, "")) as { remediation: string };
    expect(parsed.remediation).toBe("do x");
  });
});

describe("Renderer service tag exposure", () => {
  test("makePlainRendererServiceLive provides Renderer with a working message contract", async () => {
    const io = createBufferedRendererIO();
    const program = Effect.gen(function* () {
      const renderer = yield* Renderer;
      expect(renderer.id).toBe("plain");
      yield* renderer.message.error("nope", "do x");
    });
    await Effect.runPromise(program.pipe(Effect.provide(makePlainRendererServiceLive(io))));
    expect(io.stdoutLines()).toEqual(["✗ nope", "  ↳ do x"]);
  });

  test("makeJsonRendererServiceLive provides Renderer that writes to stderr", async () => {
    const io = createBufferedRendererIO();
    const program = Effect.gen(function* () {
      const renderer = yield* Renderer;
      expect(renderer.id).toBe("json");
      yield* renderer.message.info("hi");
    });
    await Effect.runPromise(program.pipe(Effect.provide(makeJsonRendererServiceLive(io))));
    expect(io.stdout()).toBe("");
    expect(io.stderrLines().length).toBe(1);
  });

  test("verbose and lando service layers expose the matching renderer id", async () => {
    const verboseIo = createBufferedRendererIO();
    const landoIo = createBufferedRendererIO();
    const verboseId = await Effect.runPromise(
      Effect.gen(function* () {
        return (yield* Renderer).id;
      }).pipe(Effect.provide(makeVerboseRendererServiceLive(verboseIo))),
    );
    const landoId = await Effect.runPromise(
      Effect.gen(function* () {
        return (yield* Renderer).id;
      }).pipe(Effect.provide(makeLandoRendererServiceLive(landoIo))),
    );
    expect(verboseId).toBe("verbose");
    expect(landoId).toBe("lando");
  });
});
