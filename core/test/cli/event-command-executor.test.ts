import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect } from "effect";

import "../../src/cli/built-in-command-registry.ts";
import { makeEventCommandExecutor } from "../../src/cli/event-command-executor.ts";

describe("EventCommandExecutorLive", () => {
  test("invokes a canonical registry Effect directly from structured input", async () => {
    // Given
    const executor = makeEventCommandExecutor(Context.make(Context.GenericTag<unknown>("test/runtime"), {}));

    // When
    const result = await Effect.runPromise(
      executor.run({
        cwd: process.cwd(),
        step: { command: "meta:version", flags: {}, args: [] },
      }),
    );

    // Then
    expect(result.exitCode).toBe(0);
  });

  test("rejects an unknown structured flag through command metadata", async () => {
    // Given
    const executor = makeEventCommandExecutor(Context.make(Context.GenericTag<unknown>("test/runtime"), {}));

    // When
    const exit = await Effect.runPromiseExit(
      executor.run({
        cwd: process.cwd(),
        step: { command: "meta:version", flags: { bogus: true } },
      }),
    );

    // Then
    expect(exit._tag).toBe("Failure");
  });

  test("runs the canonical command from the structured working directory and restores cwd", async () => {
    // Given
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "lando-event-command-")));
    const originalCwd = process.cwd();
    const executor = makeEventCommandExecutor(Context.make(Context.GenericTag<unknown>("test/runtime"), {}));

    try {
      // When
      await Effect.runPromise(executor.run({ cwd, step: { command: "meta:version" } }));

      // Then
      expect(process.cwd()).toBe(originalCwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
