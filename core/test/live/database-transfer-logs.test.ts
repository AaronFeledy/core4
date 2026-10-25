import { expect, test } from "bun:test";
import { countDatabaseCreationRecords } from "./database-transfer-logs.ts";

const creation = JSON.stringify({ event: "lando.database.created", database: "transfer_journey" });
const line = (text = creation, service = "database") => ({ service, stream: "stdout", line: text });
const envelope = (result: unknown) => ({
  apiVersion: "v4",
  command: "app:logs",
  ok: true,
  result,
  warnings: [],
  deprecations: [],
});
const wire = (...records: readonly unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");

test.each([1, 2])("counts %i real records once despite duplicate transport surfaces", (count) => {
  // Given each real record appears in both the finite payload and its stream projection.
  const lines = Array.from({ length: count }, () => line());
  const stdout = wire(
    ...lines.map((item) => ({ _tag: "stdout", service: item.service, chunk: `${item.line}\n` })),
    { _tag: "result", envelope: envelope({ app: "test", lines }) },
  );
  // When the target database's creation records are counted.
  const actual = countDatabaseCreationRecords(stdout, "transfer_journey");
  // Then transport duplication is ignored, but real repetition is preserved.
  expect(actual).toBe(count);
});

test("decodes a standalone finite envelope and ignores unrelated or non-JSON lines", () => {
  // Given only exact creation JSON for the selected service and database should count.
  const stdout = wire(
    envelope({
      app: "test",
      lines: [
        line(),
        line(creation, "consumer"),
        line(JSON.stringify({ event: "lando.database.created", database: "other" })),
        line(JSON.stringify({ event: "other", database: "transfer_journey" })),
        line(`PRINT '${creation}'`),
        line("ordinary database log"),
      ],
    }),
  );
  // When decoding the finite payload.
  const actual = countDatabaseCreationRecords(stdout, "transfer_journey");
  // Then only the actual target record counts.
  expect(actual).toBe(1);
});

test("uses stream chunks when the terminal envelope has no finite log payload", () => {
  // Given stdout and stderr records plus an event that repeats the creation text.
  const stdout = wire(
    { _tag: "stdout", service: "database", chunk: `${creation}\n` },
    { _tag: "stderr", service: "database", chunk: creation },
    { _tag: "event", event: "log.line", payload: creation },
    { _tag: "result", envelope: envelope({}) },
  );
  // When decoding the chunk-only surface.
  const actual = countDatabaseCreationRecords(stdout, "transfer_journey");
  // Then both real records count, not the event payload.
  expect(actual).toBe(2);
});

test("keeps an empty finite result authoritative over transport text", () => {
  // Given a finite payload with no logical lines.
  const stdout = wire(
    { _tag: "stdout", service: "database", chunk: creation },
    { _tag: "result", envelope: envelope({ app: "test", lines: [] }) },
  );
  // When selecting the canonical finite surface.
  const actual = countDatabaseCreationRecords(stdout, "transfer_journey");
  // Then a transport copy cannot introduce a logical record.
  expect(actual).toBe(0);
});

test("rejects an incomplete stream instead of reporting a successful count", () => {
  // Given a log frame without terminal completion.
  const stdout = wire({ _tag: "stdout", service: "database", chunk: creation });
  // When decoding the incomplete response, then completion is required.
  expect(() => countDatabaseCreationRecords(stdout, "transfer_journey")).toThrow();
});
