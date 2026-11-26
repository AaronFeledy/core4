import { afterEach, describe, expect, test } from "bun:test";
import { SqlCommandFailedError } from "@lando/sdk/errors";
import { StreamFrameSink, type StreamFrameSinkFrame } from "@lando/sdk/services";
import { Cause, Effect, Exit, Option } from "effect";

import { executeDbCommand } from "../src/run.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

afterEach(cleanupSqlTestDeps);

const text = (chunk: string | Uint8Array): string =>
  typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);

describe("db command live output", () => {
  test.each([false, true])(
    "db:reset streams the client's stderr while it runs (client fails=%s)",
    async (execFails) => {
      // Given: a database client that reports progress on stderr, and a caller that streams.
      const harness = makeSqlTestDeps({
        password: "reset-credential",
        execStderr: "NOTICE:  drop cascades to 3 other objects\n",
        execFails,
      });
      const frames: Array<{ readonly frame: StreamFrameSinkFrame; readonly publishedSoFar: string[] }> = [];
      const sink = StreamFrameSink.of({
        emit: (frame) =>
          Effect.sync(() => void frames.push({ frame, publishedSoFar: [...harness.published()] })),
      });

      // When
      const exit = await Effect.runPromiseExit(
        Effect.scoped(executeDbCommand(harness.deps, { action: "reset", yes: true })).pipe(
          Effect.provideService(StreamFrameSink, sink),
        ),
      );

      // Then: the client's output arrived, attributed to its service, before the reset completed.
      expect(frames.map(({ frame }) => [frame._tag, frame.service, text(frame.chunk)])).toEqual([
        ["stderr", "database", "NOTICE:  drop cascades to 3 other objects\n"],
      ]);
      expect(frames[0]?.publishedSoFar).not.toContain("task.complete");
      if (!execFails) {
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(harness.published()).toContain("task.complete");
        return;
      }
      // A failure still carries the client's diagnostics for the error report.
      const error = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        : undefined;
      expect(error).toBeInstanceOf(SqlCommandFailedError);
      expect(error instanceof SqlCommandFailedError ? error.stderrTail : undefined).toContain(
        "drop cascades",
      );
    },
  );
});
