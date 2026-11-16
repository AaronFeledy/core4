import { expect, test } from "bun:test";
import { RedactionService } from "@lando/redaction/service";
import { CommandInputValidationError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import {
  logBuildConflictFromInput,
  logLinesToStreamFrames,
  redactLogLineStreams,
} from "../../../src/cli/command-specs/logs-input";

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

test("redacts each collected log stream as one line sequence before any surface sees it", async () => {
  // Given a quoted secret interleaved with other services, streams, and sources.
  const web = ServiceName.make("web");
  const db = ServiceName.make("db");
  const result = {
    app: "demo",
    lines: [
      { service: web, stream: "stdout" as const, line: 'password="first', timestamp: 1 },
      { service: db, stream: "stdout" as const, line: "db ready", timestamp: 2 },
      { service: web, stream: "stdout" as const, line: "canary-log-line-secret", timestamp: 3 },
      { service: web, stream: "stderr" as const, line: "stderr stays its own stream", timestamp: 4 },
      {
        service: web,
        stream: "stdout" as const,
        source: "access",
        line: "access stays public",
        timestamp: 4.5,
      },
      { service: web, stream: "stdout" as const, line: 'last"', timestamp: 5 },
      { service: db, stream: "stdout" as const, line: "db done", timestamp: 6 },
    ],
  };

  // When
  const redacted = await Effect.runPromise(
    redactLogLineStreams(result).pipe(Effect.provide(RedactionService.layer)),
  );

  // Then the merged web block keeps its first slot and every other line keeps its own.
  expect(redacted.lines).toEqual([
    { service: web, stream: "stdout", line: "password=[redacted]", timestamp: 1 },
    { service: db, stream: "stdout", line: "db ready", timestamp: 2 },
    { service: web, stream: "stderr", line: "stderr stays its own stream", timestamp: 4 },
    { service: web, stream: "stdout", source: "access", line: "access stays public", timestamp: 4.5 },
    { service: db, stream: "stdout", line: "db done", timestamp: 6 },
  ]);
});

test("masks a registered value that spans collected log lines", async () => {
  // Given a registered secret written across two lines of one stream.
  const web = ServiceName.make("web");
  const result = {
    app: "demo",
    lines: ["before left-half", "right-half after"].map((line) => ({
      service: web,
      stream: "stdout" as const,
      line,
    })),
  };

  // When
  const redacted = await Effect.runPromise(
    RedactionService.pipe(
      Effect.tap((redaction) => redaction.registerValues(["left-half\nright-half"])),
      Effect.andThen(redactLogLineStreams(result)),
      Effect.provide(RedactionService.layer),
    ),
  );

  // Then neither half survives.
  expect(redacted.lines).toEqual([{ service: web, stream: "stdout", line: "before [redacted] after" }]);
});
