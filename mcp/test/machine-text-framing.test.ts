import { describe, expect, test } from "bun:test";
import type { StreamFrameSinkFrame } from "@lando/engine/operations/stream-frame-sink";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { makeStreamFrameSink as makeRendererSink } from "@lando/renderer/output";
import { layerJsonService } from "@lando/renderer/runtime";
import { Effect, Exit, Layer } from "effect";
import { makeStreamFrameSink as makeMcpSink } from "../src/progress";
import { projectMcpProgressFrame } from "../src/result-inspector";

type OutputFrame = {
  readonly _tag: "stdout" | "stderr";
  readonly chunk: string;
  readonly service?: string;
  readonly source?: string;
};
type Step =
  | {
      readonly action: "emit" | "lateEmit" | "producerFinalizer";
      readonly frame: StreamFrameSinkFrame;
      readonly expected: readonly OutputFrame[];
    }
  | {
      readonly action: "register";
      readonly values: readonly string[];
      readonly expected: readonly OutputFrame[];
    }
  | { readonly action: "finish"; readonly expected: readonly OutputFrame[] };
type Case = { readonly name: string; readonly secrets?: readonly string[]; readonly steps: readonly Step[] };

const stdout = (chunk: string, service?: string, source?: string): OutputFrame => ({
  _tag: "stdout",
  chunk,
  ...(service === undefined ? {} : { service }),
  ...(source === undefined ? {} : { source }),
});
const stderr = (chunk: string, service?: string, source?: string): OutputFrame => ({
  _tag: "stderr",
  chunk,
  ...(service === undefined ? {} : { service }),
  ...(source === undefined ? {} : { source }),
});
const bytes = (
  chunk: string | Uint8Array,
  _tag: "stdout" | "stderr" = "stdout",
  service?: string,
  source?: string,
): StreamFrameSinkFrame => ({
  kind: "bytes",
  _tag,
  chunk,
  ...(service === undefined ? {} : { service }),
  ...(source === undefined ? {} : { source }),
});
const record = (chunk: string): StreamFrameSinkFrame => ({ kind: "record", _tag: "stdout", chunk });
const emit = (frame: StreamFrameSinkFrame, expected: readonly OutputFrame[]): Step => ({
  action: "emit",
  frame,
  expected,
});
const finish = (expected: readonly OutputFrame[]): Step => ({ action: "finish", expected });

const secret = "private-value";
const cap = 65_536;
const a = "a".repeat(cap - 1);
const b = "b".repeat(cap - 1);
const oversized = "r".repeat(cap);
const unicodeRecord = `${"u".repeat(cap - 2)}😀`;
const invalid = new Uint8Array(cap).fill(0xff);
const decoderTail = new Uint8Array(cap).fill(0x78);
decoderTail[cap - 1] = 0xe2;
const secretEdge = "x".repeat(cap - 4);
const secretEdgeFrames = [stdout(`${secretEdge}[red`), stdout("acted]\n")];

// Extraction is deferred: renderer retains pending bytes until a write succeeds,
// while MCP detaches bytes before notification and removes channels before draining.
// Sharing the loop would change failure semantics or require owner-specific policy.
// This corpus pins their common framing behavior while those owners stay separate.
const cases: readonly Case[] = [
  {
    name: "split BOM, UTF-8, and CRLF keep their exact framing",
    steps: [
      emit(bytes(Uint8Array.of(0xef)), []),
      emit(bytes(Uint8Array.of(0xbb, 0xbf, 0x61, 0x0d)), []),
      emit(bytes(Uint8Array.of(0x0a, 0xe2)), [stdout("\ufeffa\r\n")]),
      emit(bytes(Uint8Array.of(0x82)), [stdout("\ufeffa\r\n")]),
      emit(bytes(Uint8Array.of(0xac, 0x0a)), [stdout("\ufeffa\r\n"), stdout("€\n")]),
      finish([stdout("\ufeffa\r\n"), stdout("€\n")]),
    ],
  },
  {
    name: "a four-byte code point crossing the cap resumes in the next frame",
    steps: [
      emit(bytes(new TextEncoder().encode(`${a}😀\n`)), [stdout(a), stdout("😀\n")]),
      finish([stdout(a), stdout("😀\n")]),
    ],
  },
  {
    name: "empty records and the 64 KiB boundary emit completed pieces immediately",
    steps: [
      emit(bytes(""), []),
      emit(record(""), [stdout("\n")]),
      emit(record("done\n"), [stdout("\n"), stdout("done\n"), stdout("\n")]),
      emit(bytes(`${a}\n`), [stdout("\n"), stdout("done\n"), stdout("\n"), stdout(`${a}\n`)]),
      emit(bytes(`${b}\r\n`), [
        stdout("\n"),
        stdout("done\n"),
        stdout("\n"),
        stdout(`${a}\n`),
        stdout(`${b}\r`),
        stdout("\n"),
      ]),
      emit(record(oversized), [
        stdout("\n"),
        stdout("done\n"),
        stdout("\n"),
        stdout(`${a}\n`),
        stdout(`${b}\r`),
        stdout("\n"),
        stdout(oversized),
        stdout("\n"),
      ]),
      finish([
        stdout("\n"),
        stdout("done\n"),
        stdout("\n"),
        stdout(`${a}\n`),
        stdout(`${b}\r`),
        stdout("\n"),
        stdout(oversized),
        stdout("\n"),
      ]),
    ],
  },
  {
    name: "invalid input expands after byte-bounded segmentation",
    steps: [emit(bytes(invalid), [stdout("�".repeat(cap))]), finish([stdout("�".repeat(cap))])],
  },
  {
    name: "an oversized Unicode record splits a code point across frame segments",
    steps: [
      emit(record(unicodeRecord), [stdout("u".repeat(cap - 2)), stdout("😀\n")]),
      finish([stdout("u".repeat(cap - 2)), stdout("😀\n")]),
    ],
  },
  {
    name: "a record drains bytes and resets the decoder before later bytes",
    steps: [
      emit(bytes(Uint8Array.of(0xe2)), []),
      emit(record("line"), [stdout("�"), stdout("line\n")]),
      emit(bytes(Uint8Array.of(0x82, 0xac, 0x0a)), [stdout("�"), stdout("line\n"), stdout("��\n")]),
      finish([stdout("�"), stdout("line\n"), stdout("��\n")]),
    ],
  },
  {
    name: "registered values survive chunk and 64 KiB input boundaries",
    secrets: [secret],
    steps: [
      emit(bytes("pre private-"), []),
      emit(bytes("value\r\n"), [stdout("pre [redacted]\r\n")]),
      emit(bytes(`${secretEdge}${secret}\n`), [stdout("pre [redacted]\r\n"), ...secretEdgeFrames]),
      finish([stdout("pre [redacted]\r\n"), ...secretEdgeFrames]),
    ],
  },
  {
    name: "a value registered after a held prefix is still masked",
    secrets: ["private-longer"],
    steps: [
      emit(bytes("private-"), []),
      { action: "register", values: [secret], expected: [] },
      emit(bytes("value\n"), [stdout("[redacted]\n")]),
      finish([stdout("[redacted]\n")]),
    ],
  },
  {
    name: "an unmatched secret prefix is released on finish",
    secrets: [secret],
    steps: [emit(bytes("plain private-"), []), finish([stdout("plain private-")])],
  },
  {
    name: "metadata channels keep decoder and secret tails isolated",
    secrets: [secret],
    steps: [
      emit(bytes("private-", "stdout", "app", "one"), []),
      emit(bytes("value\n", "stderr", "app", "one"), [stderr("value\n", "app", "one")]),
      emit(bytes(Uint8Array.of(0xe2), "stdout", "app", "two"), [stderr("value\n", "app", "one")]),
      emit(bytes("value\n", "stdout", "app", "one"), [
        stderr("value\n", "app", "one"),
        stdout("[redacted]\n", "app", "one"),
      ]),
      emit(bytes(Uint8Array.of(0x82, 0xac, 0x0a), "stdout", "app", "two"), [
        stderr("value\n", "app", "one"),
        stdout("[redacted]\n", "app", "one"),
        stdout("€\n", "app", "two"),
      ]),
      finish([
        stderr("value\n", "app", "one"),
        stdout("[redacted]\n", "app", "one"),
        stdout("€\n", "app", "two"),
      ]),
    ],
  },
  {
    name: "a producer finalizer precedes owner finish, which is idempotent and closes emit",
    steps: [
      emit(bytes("head"), []),
      { action: "producerFinalizer", frame: bytes(" tail"), expected: [] },
      finish([stdout("head tail")]),
      finish([stdout("head tail")]),
      { action: "lateEmit", frame: bytes("too late\n"), expected: [stdout("head tail")] },
    ],
  },
  {
    name: "a decoder-only tail flushes on finish",
    steps: [
      emit(bytes(decoderTail), [stdout("x".repeat(cap - 1))]),
      finish([stdout("x".repeat(cap - 1)), stdout("�")]),
    ],
  },
  {
    name: "finish drains incomplete metadata channels in insertion order",
    steps: [
      emit(bytes("first", "stdout", "app", "one"), []),
      emit(bytes("second", "stderr", "app", "two"), []),
      emit(bytes("third", "stdout", "db", "one"), []),
      finish([stdout("first", "app", "one"), stderr("second", "app", "two"), stdout("third", "db", "one")]),
    ],
  },
];

const makeHarness = async (surface: "renderer" | "mcp", secrets: readonly string[]) => {
  const service = makeRedactionService();
  await Effect.runPromise(service.registerValues([...secrets]));
  if (surface === "mcp") {
    const frames: OutputFrame[] = [];
    const redactor = await Effect.runPromise(service.forProfile("secrets", { sourceEnv: {} }));
    const values = await Effect.runPromise(service.payloadValues({ sourceEnv: {} }));
    const owner = makeMcpSink(
      (frame) =>
        Effect.sync(() => {
          frames.push(projectMcpProgressFrame(frame));
        }),
      redactor,
      values,
    );
    return { sink: owner.sink, finish: owner.finish, frames: () => frames, service };
  }
  const io = createBufferedRendererIO();
  // Renderer production supplies process.env. Keep this corpus independent of the host's secrets.
  const isolated = Layer.succeed(RedactionService, {
    ...service,
    forProfile: (profile, options) => service.forProfile(profile, { ...options, sourceEnv: {} }),
    payloadValues: (options) => service.payloadValues({ ...options, sourceEnv: {} }),
  });
  const owner = await Effect.runPromise(
    makeRendererSink("json").pipe(Effect.provide(Layer.merge(layerJsonService(io), isolated))),
  );
  return {
    sink: owner.sink,
    finish: owner.finish,
    frames: () => {
      expect(io.stderr()).toBe("");
      return io.stdoutLines().map((line) => JSON.parse(line) as OutputFrame);
    },
    service,
  };
};

describe("machine text framing conformance", () => {
  for (const surface of ["renderer", "mcp"] as const) {
    for (const scenario of cases) {
      test(`${surface}: ${scenario.name}`, async () => {
        const harness = await makeHarness(surface, scenario.secrets ?? []);
        for (const [index, step] of scenario.steps.entries()) {
          if (step.action === "emit") await Effect.runPromise(harness.sink.emit(step.frame));
          else if (step.action === "register")
            await Effect.runPromise(harness.service.registerValues([...step.values]));
          else if (step.action === "producerFinalizer") {
            await Effect.runPromise(Effect.scoped(Effect.addFinalizer(() => harness.sink.emit(step.frame))));
          } else if (step.action === "lateEmit") {
            const exit = await Effect.runPromiseExit(harness.sink.emit(step.frame));
            expect(Exit.isFailure(exit)).toBe(true);
          } else await Effect.runPromise(harness.finish());
          expect(harness.frames(), `${scenario.name}, step ${index + 1}`).toEqual([...step.expected]);
        }
      });
    }
  }
});
