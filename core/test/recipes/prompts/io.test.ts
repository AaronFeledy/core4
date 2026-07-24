import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";

import { PromptCancelledError } from "../../../src/recipes/prompts/driver.ts";
import { createLineReader } from "../../../src/recipes/prompts/io.ts";

const expectReleased = (stream: PassThrough): void => {
  expect(stream.listenerCount("data")).toBe(0);
  expect(stream.listenerCount("end")).toBe(0);
  expect(stream.listenerCount("error")).toBe(0);
  expect(stream.isPaused()).toBe(true);
};

describe("createLineReader", () => {
  test("returns sequential buffered-ahead lines from one chunk", async () => {
    // Given
    const stream = new PassThrough();
    const reader = createLineReader(stream);
    stream.end("first\nsecond\n");

    // When
    const first = await reader.readLine();
    const second = await reader.readLine();
    const third = await reader.readLine();

    // Then
    expect(first).toBe("first");
    expect(second).toBe("second");
    expect(third).toBe("");
    expectReleased(stream);
  });

  test("strips CR from CRLF lines", async () => {
    // Given
    const stream = new PassThrough();
    const reader = createLineReader(stream);
    stream.end("windows\r\n");

    // When
    const line = await reader.readLine();

    // Then
    expect(line).toBe("windows");
  });

  test("returns the final unterminated tail at end", async () => {
    // Given
    const stream = new PassThrough();
    const reader = createLineReader(stream);
    stream.end("tail");

    // When
    const line = await reader.readLine();

    // Then
    expect(line).toBe("tail");
  });

  test("detaches listeners and pauses after a successful read", async () => {
    // Given
    const stream = new PassThrough();
    const reader = createLineReader(stream);

    // When
    const linePromise = reader.readLine();
    stream.write("answer\n");
    const line = await linePromise;

    // Then
    expect(line).toBe("answer");
    expectReleased(stream);
  });

  test("detaches listeners and pauses after cancellation", async () => {
    // Given
    const stream = new PassThrough();
    const reader = createLineReader(stream);
    const controller = new AbortController();
    const linePromise = reader.readLine(controller.signal);

    // When
    controller.abort();

    // Then
    const cause = await linePromise.catch((caught: unknown) => caught);
    expect(cause).toBeInstanceOf(PromptCancelledError);
    expectReleased(stream);
  });

  test("remains reusable after cancellation", async () => {
    // Given
    const stream = new PassThrough();
    const reader = createLineReader(stream);
    const controller = new AbortController();
    const cancelledRead = reader.readLine(controller.signal);
    controller.abort();
    const cancellation = await cancelledRead.catch((cause: unknown) => cause);
    expect(cancellation).toBeInstanceOf(PromptCancelledError);

    // When
    const resumedRead = reader.readLine();
    stream.write("recovered\n");

    // Then
    expect(await resumedRead).toBe("recovered");
    expectReleased(stream);
  });

  test("detaches listeners and pauses after a stream error", async () => {
    // Given
    const stream = new PassThrough();
    const reader = createLineReader(stream);
    const failure = new Error("read failed");

    // When
    const linePromise = reader.readLine();
    stream.emit("error", failure);

    // Then
    const cause = await linePromise.catch((caught: unknown) => caught);
    expect(cause).toBe(failure);
    expectReleased(stream);
  });
});
