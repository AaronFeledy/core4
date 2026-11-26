import { describe, expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { StreamFrame } from "@lando/sdk/schema";
import { Effect, Layer, Schema } from "effect";
import { metaDoctorSpec } from "../../src/cli/command-specs/meta/doctor.ts";
import type { DoctorReport } from "../../src/cli/commands/doctor-report.ts";
import {
  DoctorReportSchema,
  doctorCompletion,
  makeDoctorReport,
} from "../../src/cli/commands/doctor-report.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const decodeFrames = (ndjson: string): ReadonlyArray<StreamFrame> =>
  ndjson
    .trimEnd()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));

const runDoctorNdjson = async (operation: Effect.Effect<DoctorReport, unknown, RedactionService>) => {
  const io = createBufferedRendererIO();
  const exitCodes: number[] = [];
  const report = metaDoctorSpec.ndjsonReport;
  if (report === undefined) throw new Error("meta:doctor must supply its ndjson report");
  await runWithRendererHandling(operation, {
    runtime: Layer.succeed(RedactionService, RedactionService.of(makeRedactionService())),
    rendererMode: "plain",
    resultFormat: "ndjson",
    command: "meta:doctor",
    resultSchema: DoctorReportSchema,
    ndjsonReport: report,
    completion: doctorCompletion,
    io,
    setExitCode: (code) => exitCodes.push(code),
    formatError: ({ error }) => String(error),
  });
  return { frames: decodeFrames(io.stdout()), stdout: io.stdout(), exitCodes };
};

describe("doctor --format=ndjson", () => {
  test("an injected secrets redactor masks a registered secret in a doctor check result", async () => {
    const secret = "us383-doctor-secret-value";
    const { frames, stdout } = await runDoctorNdjson(
      Effect.gen(function* () {
        const redaction = yield* RedactionService;
        yield* redaction.registerValues([secret]);
        return makeDoctorReport({
          version: "4.0.0-test",
          checks: [
            {
              section: "provider",
              name: "leaky-check",
              status: "fail",
              severity: "error",
              context: { detail: `leaked ${secret}` },
              solutions: [],
            },
          ],
          skipped: [],
        });
      }),
    );

    expect(stdout).not.toContain(secret);
    const [event] = frames;
    expect(event?._tag).toBe("event");
    const payload = (event as Extract<StreamFrame, { readonly _tag: "event" }>).payload as {
      readonly context?: { readonly detail?: string };
    };
    expect(payload.context?.detail).toContain("[redacted]");
    expect(payload.context?.detail).not.toContain(secret);
  });

  test("a doctor that cannot finish ends its stream in one failure result frame", async () => {
    const { frames, exitCodes } = await runDoctorNdjson(Effect.die(new Error("doctor crashed")));

    expect(frames.map((frame) => frame._tag)).toEqual(["result"]);
    expect(frames[0]).toMatchObject({ envelope: { command: "meta:doctor", ok: false } });
    expect(exitCodes).toEqual([1]);
  });
});
