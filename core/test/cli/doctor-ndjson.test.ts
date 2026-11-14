import { describe, expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { StreamFrame } from "@lando/sdk/schema";
import { Effect, Layer, Schema } from "effect";
import { renderDoctorReportAsNdjson } from "../../src/cli/commands/doctor-render-ndjson.ts";
import { DoctorReportSchema, makeDoctorReport } from "../../src/cli/commands/doctor-report.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const eventLines = (ndjson: string): ReadonlyArray<StreamFrame> =>
  ndjson
    .trimEnd()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)))
    .filter((frame) => frame._tag === "event");

describe("renderDoctorReportAsNdjson redaction boundary", () => {
  test("an injected secrets redactor masks a registered secret in a doctor check result", async () => {
    const secret = "us383-doctor-secret-value";
    const io = createBufferedRendererIO();

    await runWithRendererHandling(
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
      {
        runtime: Layer.succeed(RedactionService, RedactionService.of(makeRedactionService())),
        rendererMode: "plain",
        resultFormat: "ndjson",
        command: "meta:doctor",
        resultSchema: DoctorReportSchema,
        io,
        render: (report) => renderDoctorReportAsNdjson(report),
        formatError: ({ error }) => String(error),
      },
    );

    const ndjson = io.stdout();
    expect(ndjson).not.toContain(secret);
    expect(ndjson).toContain("[redacted]");

    const [event] = eventLines(ndjson);
    expect(event?._tag).toBe("event");
    const payload = (event as Extract<StreamFrame, { readonly _tag: "event" }>).payload as {
      readonly context?: { readonly detail?: string };
    };
    expect(payload.context?.detail).toContain("[redacted]");
    expect(payload.context?.detail).not.toContain(secret);
  });
});
