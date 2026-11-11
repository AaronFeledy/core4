import { expect, test } from "bun:test";
import { CommandInputValidationError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";
import { logBuildConflictFromInput, logLinesToStreamFrames } from "../../../src/cli/command-specs/logs-input";

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

test.each(["since", "source"] as const)("rejects --build with a supplied but empty --%s", (flag) => {
  // Given an input that supplies an empty value for a stream-selecting flag.
  const input = { flags: { build: true, [flag]: "" } };

  // When
  const error = logBuildConflictFromInput(input);

  // Then the flag's presence alone is the conflict, not the length of its value.
  expect(error).toBeInstanceOf(CommandInputValidationError);
  expect(error?.field).toBe(flag);
  expect(error?.reason).toBe("conflict");
  expect(error?.remediation).toBe(`Remove --${flag} when using --build.`);
});
