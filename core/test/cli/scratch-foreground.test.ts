import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";

import {
  renderScratchStartResult,
  scratchStartOptionsFromInput,
  waitForAbortSignal,
} from "../../src/cli/commands/scratch.ts";

const fakeHandle = {
  id: "scratch-demo-abc123",
  app: { kind: "scratch", id: "scratch-demo-abc123", root: "/x" },
} as const;

describe("scratch start foreground signal handling", () => {
  test("waitForAbortSignal resolves immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const completed = await Effect.runPromise(waitForAbortSignal(controller.signal).pipe(Effect.as("done")));
    expect(completed).toBe("done");
  });

  test("waitForAbortSignal resolves once the signal aborts mid-wait", async () => {
    const controller = new AbortController();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(waitForAbortSignal(controller.signal).pipe(Effect.as("aborted")));
        yield* Effect.sync(() => controller.abort());
        return yield* Fiber.join(fiber);
      }),
    );
    expect(result).toBe("aborted");
  });

  test("scratchStartOptionsFromInput threads the OCLIF abort signal", () => {
    const controller = new AbortController();
    const options = scratchStartOptionsFromInput({ flags: { fork: true }, signal: controller.signal });
    expect(options.signal).toBe(controller.signal);
  });

  test("renderScratchStartResult suppresses output for an already-rendered foreground result", () => {
    expect(renderScratchStartResult({ handle: fakeHandle, detached: false, rendered: true })).toBeUndefined();
  });

  test("renderScratchStartResult renders the bare id for a detached result", () => {
    expect(renderScratchStartResult({ handle: fakeHandle, detached: true })).toBe(fakeHandle.id);
  });
});
