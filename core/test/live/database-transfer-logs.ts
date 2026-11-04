import assert from "node:assert/strict";
import { CommandResultEnvelope, StreamFrame } from "@lando/sdk/schema";
import { Option, Schema } from "effect";

const logLine = Schema.Struct({
  service: Schema.optionalKey(Schema.String),
  stream: Schema.Literals(["stdout", "stderr"]),
  line: Schema.String,
});
const logsResult = Schema.Struct({ app: Schema.String, lines: Schema.Array(logLine) });
const decodeWireRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Union([CommandResultEnvelope, StreamFrame])),
);
const decodeCreationRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ event: Schema.Literal("lando.database.created"), database: Schema.String }),
  ),
);

export const countDatabaseCreationRecords = (stdout: string, database: string): number => {
  let envelope: CommandResultEnvelope | undefined;
  const chunks: Array<typeof logLine.Type> = [];
  for (const text of stdout.split("\n").filter((line) => line.trim().length > 0)) {
    const record = decodeWireRecord(text);
    if (!("_tag" in record)) {
      envelope = record;
      continue;
    }
    switch (record._tag) {
      case "stdout":
      case "stderr":
        chunks.push({
          ...(record.service === undefined ? {} : { service: record.service }),
          stream: record._tag,
          line: record.chunk,
        });
        break;
      case "result":
        envelope = record.envelope;
        break;
      case "event":
        break;
      default:
        record satisfies never;
    }
  }
  assert.ok(envelope?.ok, "Expected successful logs completion");
  assert.equal(envelope.command, "app:logs");
  const result = Schema.decodeUnknownOption(logsResult)(envelope.result);
  // Finite results repeat their lines in frames. Select one surface, never deduplicate real records.
  const lines = Option.isSome(result) ? result.value.lines : chunks;
  return lines.filter((line) => {
    if (line.service !== "database") return false;
    const record = decodeCreationRecord(line.line.trim());
    return Option.isSome(record) && record.value.database === database;
  }).length;
};
