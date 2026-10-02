import { expect, test } from "bun:test";
import { Logger } from "@lando/sdk/services";
import { Effect } from "effect";
import { LoggerLive } from "../../src/logging/service.ts";

test("structured diagnostics preserve the exact JSON record keys", async () => {
  const lines: string[] = [];
  const layer = LoggerLive({
    logLevel: "info",
    structured: true,
    stderrIsTTY: true,
    writeLine: (line) => {
      lines.push(line);
    },
  });

  await Effect.runPromise(
    Effect.flatMap(Logger, (logger) => logger.info("record-marker", { operation: "characterize" })).pipe(
      Effect.provide(layer),
    ),
  );

  expect(lines).toHaveLength(1);
  const record: unknown = JSON.parse(lines[0] ?? "null");
  expect(record).toBeObject();
  if (record === null || typeof record !== "object") throw new Error("expected a JSON log object");
  expect(Object.keys(record).sort()).toEqual([
    "annotations",
    "fiberId",
    "logLevel",
    "message",
    "spans",
    "timestamp",
  ]);
  expect(record).toMatchObject({
    message: "record-marker",
    logLevel: "INFO",
    annotations: { operation: "characterize" },
    spans: {},
  });
});
