import { expect, test } from "bun:test";
import { ServiceName } from "@lando/sdk/schema";
import { logLinesToStreamFrames } from "../../../src/cli/command-specs/logs-input";

test("preserves stream and source when projecting log lines to frames", () => {
  const service = ServiceName.make("web");
  const input = {
    lines: [
      { service, stream: "stdout" as const, line: "hello" },
      { service, stream: "stderr" as const, line: "error", source: "access" },
    ],
  };
  const result = logLinesToStreamFrames(input);
  expect(result).toEqual([
    { _tag: "stdout", service: "web", chunk: "hello\n" },
    { _tag: "stderr", service: "web", chunk: "error\n", source: "access" },
  ]);
});

test("emits no frames when no lines exist", () => {
  const result = logLinesToStreamFrames({ lines: [] });
  expect(result).toEqual([]);
});
