/**
 * Every built-in command, run through the renderer boundary with the options
 * the compiled runtime derives from its spec, writes exactly one terminal
 * document in each machine format it advertises and sets one exit status, even
 * when the command, its runtime teardown, or the terminal write fails.
 */

import { describe, expect, test } from "bun:test";

import { type BufferedRendererIO, createBufferedRendererIO } from "@lando/renderer/io";
import { CommandResultEnvelope, StreamFrame } from "@lando/sdk/schema";
import { Effect, Layer, Schema } from "effect";

import { builtInCommandEntries } from "../../src/cli/built-in-command-registry.ts";
import { compiledCommandTransportOptions } from "../../src/cli/compiled-runtime.ts";
import {
  advertisedOptInFormats,
  commandResultFormats,
  emitsFrames,
  isMachineResultFormat,
} from "../../src/cli/format-flags.ts";
import { COMMAND_REGISTRY_MANIFEST } from "../../src/cli/generated/command-registry-manifest.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import type { LandoCommandSpec } from "../../src/cli/spec/command-spec.ts";

class CommandFailure extends Schema.TaggedError<CommandFailure>()("CommandFailure", {
  message: Schema.String,
  remediation: Schema.String,
}) {}

const decodeEnvelope = Schema.decodeUnknownSync(CommandResultEnvelope);
const decodeFrame = Schema.decodeUnknownSync(StreamFrame);

type MachineFormat = "json" | "yaml" | "ndjson";
type Failure = "command" | "teardown" | "write";

const implemented = builtInCommandEntries.filter((entry) => entry.status.kind === "implemented");

const machineFormats = (spec: LandoCommandSpec): ReadonlyArray<MachineFormat> =>
  commandResultFormats(spec).filter(isMachineResultFormat);

const failingTeardown = Layer.effectDiscard(
  Effect.addFinalizer(() => Effect.die(new Error("teardown failed"))),
);

const run = async (spec: LandoCommandSpec, format: MachineFormat, failure: Failure) => {
  const buffered = createBufferedRendererIO();
  const io: BufferedRendererIO =
    failure === "write"
      ? {
          ...buffered,
          writeStdout: () => {
            throw new Error("stdout write failed");
          },
        }
      : buffered;
  const exitCodes: number[] = [];
  const live = spec.streamingMode === undefined ? undefined : "live";
  await runWithRendererHandling(
    Effect.fail(new CommandFailure({ message: "command failed", remediation: "Fix the command." })),
    {
      command: spec.id,
      runtime: failure === "teardown" ? failingTeardown : Layer.empty,
      rendererMode: "plain",
      resultFormat: format,
      resultSchema: spec.resultSchema,
      ...compiledCommandTransportOptions(spec, live),
      ...(spec.documentOutput?.format === format ? { documentOutput: true } : {}),
      io,
      setExitCode: (code) => exitCodes.push(code),
      formatError: ({ error }) => String(error),
    },
  );
  return { stdout: buffered.stdout(), exitCodes, framed: emitsFrames(spec) };
};

const expectOneFailureDocument = (format: MachineFormat, framed: boolean, stdout: string) => {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  if (format === "yaml") {
    expect(stdout).not.toContain("\n---");
    expect(decodeEnvelope(Bun.YAML.parse(stdout))).toMatchObject({ ok: false });
    return;
  }
  if (format === "json" && !framed) {
    expect(lines).toHaveLength(1);
    expect(decodeEnvelope(JSON.parse(lines[0] ?? ""))).toMatchObject({ ok: false });
    return;
  }
  // ndjson always, and json on a framed command: every line is a frame and one result ends it.
  const frames = lines.map((line) => decodeFrame(JSON.parse(line)));
  expect(frames.filter((frame) => frame._tag === "result")).toHaveLength(1);
  expect(frames.at(-1)).toMatchObject({ _tag: "result", envelope: { ok: false } });
};

describe("advertised formats", () => {
  test("the generated manifest that cold help reads offers exactly the formats each command produces", () => {
    const manifest: Readonly<
      Record<
        string,
        {
          readonly flags?: { readonly format?: { readonly options?: ReadonlyArray<string> } };
          readonly spec: { readonly id: string; readonly advertisedFormats?: ReadonlyArray<string> };
        }
      >
    > = COMMAND_REGISTRY_MANIFEST.commands;
    for (const { spec } of implemented) {
      const entry = manifest[spec.id];
      expect(entry?.flags?.format?.options).toEqual([...commandResultFormats(spec)]);
      const optIn = advertisedOptInFormats(spec);
      expect(entry?.spec.advertisedFormats).toEqual(optIn.length === 0 ? undefined : [...optIn]);
    }
  });
});

describe("one terminal document and one exit status per machine run", () => {
  for (const { spec } of implemented)
    for (const format of machineFormats(spec)) {
      for (const failure of ["command", "teardown"] as const)
        test(`${spec.id} --format=${format}, ${failure} failure`, async () => {
          const { stdout, exitCodes, framed } = await run(spec, format, failure);
          expectOneFailureDocument(format, framed, stdout);
          expect(exitCodes).toEqual([1]);
        });
      test(`${spec.id} --format=${format}, terminal write failure`, async () => {
        const { stdout, exitCodes } = await run(spec, format, "write");
        expect(stdout).toBe("");
        expect(exitCodes).toEqual([1]);
      });
    }
});
