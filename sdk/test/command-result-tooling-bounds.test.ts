import { expect, test } from "bun:test";
import {
  buildCommandResultEnvelope,
  encodeCommandResult,
  encodeStreamResultFrame,
  projectToolingDiagnostic,
} from "@lando/sdk/command-result";
import { LandofileEventStepFailedError, ToolingCompileError } from "@lando/sdk/errors";
import { CommandResultEnvelope, StreamFrame } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";

const error = new ToolingCompileError({
  tool: "run",
  source: { path: `/app/${"\n".repeat(2000)}.yml`, task: "run" },
  message: "\n".repeat(1000),
  remediation: `Correct ${"\n".repeat(1000)}`,
  omittedIssueCount: 3,
  issues: Array.from({ length: 10 }, (_, index) => ({
    path: ["tooling", "run", index],
    message: `Invalid ${"\n".repeat(400)}`,
    source: { layer: "canonical" as const, file: "/app/whole.yml", path: ["tooling", "run", index] },
  })),
});
const redactor = createRedactor("secrets", { values: [String.raw`\n`] });
const options = {
  command: "app:run",
  resultSchema: Schema.Void,
  outcome: { _tag: "failure" as const, error, additionalErrors: [{ role: "cleanup" as const, error }] },
  redactor,
};

for (const format of ["json", "yaml", "frame"] as const) {
  test(`bounds primary and additional tooling errors after final token redaction in ${format}`, () => {
    const line = Effect.runSync(
      format === "frame" ? encodeStreamResultFrame(options) : encodeCommandResult({ ...options, format }),
    );
    const envelope =
      format === "frame"
        ? Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line))
        : Schema.decodeUnknownSync(CommandResultEnvelope)(
            format === "yaml" ? Bun.YAML.parse(line) : JSON.parse(line),
          );
    const result = "_tag" in envelope && envelope._tag === "result" ? envelope.envelope : envelope;
    expect(result).toHaveProperty("error");
    if (!("error" in result) || result.error === undefined) throw new Error("Missing error envelope");
    for (const diagnostic of [result.error, ...(result.error.additionalErrors ?? [])]) {
      expect(diagnostic._tag).toBe("ToolingCompileError");
      const { additionalErrors: _additional, ...ownDiagnostic } = diagnostic;
      expect(Buffer.byteLength(JSON.stringify(ownDiagnostic))).toBeLessThanOrEqual(16 * 1024);
      expect(Buffer.byteLength(JSON.stringify(diagnostic.message))).toBeLessThanOrEqual(1024);
      expect(Buffer.byteLength(JSON.stringify(diagnostic.remediation))).toBeLessThanOrEqual(1024);
      expect(diagnostic).not.toHaveProperty("source");
      expect(diagnostic.issues?.map((issue) => issue.path.at(-1))).toEqual([0, 1, 2]);
      expect(diagnostic.omittedIssueCount).toBe(10);
      expect(
        diagnostic.issues?.every(
          (issue) => issue.source?.layer === "canonical" && issue.source.file === "/app/whole.yml",
        ),
      ).toBe(true);
    }
  });
}

test("projection is idempotent with omitted findings and token expansion", () => {
  const projected = projectToolingDiagnostic(error, redactor);
  expect(projectToolingDiagnostic(projected, redactor)).toEqual(projected);
  expect(projected.omittedIssueCount).toBe(10);
});

test("builds a bounded tooling diagnostic for transports that redact the envelope later", () => {
  const envelope = Effect.runSync(buildCommandResultEnvelope(options));
  const { additionalErrors: _additional, ...diagnostic } = envelope.error ?? {};
  const published = redactor.redactString(JSON.stringify(diagnostic));
  expect(Buffer.byteLength(published)).toBeLessThanOrEqual(16 * 1024);
  expect(envelope.error?.issues).toHaveLength(3);
  expect(envelope.error?.omittedIssueCount).toBe(10);
});

test("bounds the final event refusal, including its identity and already-prefixed summaries", () => {
  const event = `event-${"界".repeat(5000)}`;
  const refusal = new LandofileEventStepFailedError({
    event,
    index: 8,
    kind: "command",
    message: `Event ${event} did not run.`,
    outputTail: "",
    remediation: "Fix the event.",
    issues: [{ path: ["events", event, 8, "command"], message: "Refused." }],
  });
  const line = Effect.runSync(
    encodeCommandResult({
      ...options,
      outcome: { _tag: "failure", error: refusal, additionalErrors: [{ role: "cleanup", error: refusal }] },
    }),
  );
  const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line));
  for (const diagnostic of [envelope.error, ...(envelope.error?.additionalErrors ?? [])]) {
    if (diagnostic === undefined) throw new Error("Missing error envelope");
    expect(diagnostic).toMatchObject({
      _tag: "LandofileEventStepFailedError",
      event,
      index: 8,
      step: 9,
      issues: [],
      omittedIssueCount: 1,
    });
    const { additionalErrors: _additional, ...ownDiagnostic } = diagnostic;
    expect(Buffer.byteLength(JSON.stringify(ownDiagnostic))).toBeLessThanOrEqual(16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(diagnostic.message))).toBeLessThanOrEqual(1024);
  }
});

test("a tooling cause uses the tagged diagnostic policy before normal envelope redaction", () => {
  const cause = {
    _tag: "UnrecognizedInputError",
    message: "Cannot locate a registered input.",
    remediation: "Check the input name.",
    token: "safe-input-name",
    path: "/contains-a-registered-secret",
  };
  const opts = { ...options, redactor: createRedactor("secrets", { values: ["registered-secret"] }) };
  const publish = (error: unknown) =>
    Schema.decodeUnknownSync(CommandResultEnvelope)(
      JSON.parse(
        Effect.runSync(
          encodeCommandResult({ ...opts, outcome: { _tag: "failure", error, additionalErrors: [] } }),
        ),
      ),
    ).error;
  const tooling = new ToolingCompileError({ tool: "run", message: "Refused.", cause });
  const projected = Effect.runSync(
    buildCommandResultEnvelope({
      ...opts,
      outcome: { _tag: "failure", error: tooling, additionalErrors: [] },
    }),
  );
  expect(projected.error?.cause).toMatchObject({ token: "safe-input-name", path: "/contains-a-[redacted]" });
  expect(publish(tooling)?.cause).toEqual(publish({ _tag: "Outer", message: "Refused.", cause })?.cause);
});
