import { describe, expect, test } from "bun:test";

import { tryDriverConfirm, tryDriverSelect } from "../../../src/cli/prompts/interactive.ts";
import { PromptCancelledError, type PromptDriver } from "../../../src/recipes/prompts/driver.ts";
import { createBufferedPromptIO } from "../../../src/recipes/prompts/index.ts";

const driverReturning = (value: string): PromptDriver => ({ readRaw: async () => value });
const driverThrowing = (error: Error): PromptDriver => ({
  readRaw: async () => {
    throw error;
  },
});

describe("tryDriverConfirm", () => {
  test("returns undefined when no driver is active (caller keeps line path)", async () => {
    const io = createBufferedPromptIO({ inputs: [], isTTY: true });
    expect(await tryDriverConfirm(undefined, io, { message: "OK?" })).toBeUndefined();
  });

  test("returns undefined when io is not a TTY", async () => {
    const io = createBufferedPromptIO({ inputs: [], isTTY: false });
    expect(await tryDriverConfirm(driverReturning("y"), io, { message: "OK?" })).toBeUndefined();
  });

  test("maps an affirmative driver answer to true", async () => {
    const io = createBufferedPromptIO({ inputs: [], isTTY: true });
    expect(await tryDriverConfirm(driverReturning("y"), io, { message: "OK?" })).toBe(true);
  });

  test("maps a negative driver answer to false", async () => {
    const io = createBufferedPromptIO({ inputs: [], isTTY: true });
    expect(await tryDriverConfirm(driverReturning("n"), io, { message: "OK?" })).toBe(false);
  });

  test("propagates cancellation", async () => {
    const io = createBufferedPromptIO({ inputs: [], isTTY: true });
    await expect(
      tryDriverConfirm(driverThrowing(new PromptCancelledError()), io, { message: "OK?" }),
    ).rejects.toBeInstanceOf(PromptCancelledError);
  });

  test("returns undefined (fall back) when the driver declines with a generic error", async () => {
    const io = createBufferedPromptIO({ inputs: [], isTTY: true });
    expect(
      await tryDriverConfirm(driverThrowing(new Error("declines")), io, { message: "OK?" }),
    ).toBeUndefined();
  });
});

describe("tryDriverSelect", () => {
  test("resolves the 1-based index returned by the driver to its choice value", async () => {
    const io = createBufferedPromptIO({ inputs: [], isTTY: true });
    const value = await tryDriverSelect(driverReturning("2"), io, {
      message: "Pick a provider",
      choices: [{ value: "lando" }, { value: "docker" }, { value: "podman" }],
    });
    expect(value).toBe("docker");
  });

  test("returns undefined for an out-of-range index (fall back)", async () => {
    const io = createBufferedPromptIO({ inputs: [], isTTY: true });
    const value = await tryDriverSelect(driverReturning("9"), io, {
      message: "Pick",
      choices: [{ value: "a" }, { value: "b" }],
    });
    expect(value).toBeUndefined();
  });

  test("returns undefined when no driver is active", async () => {
    const io = createBufferedPromptIO({ inputs: [], isTTY: true });
    expect(
      await tryDriverSelect(undefined, io, { message: "Pick", choices: [{ value: "a" }] }),
    ).toBeUndefined();
  });

  test("propagates cancellation", async () => {
    const io = createBufferedPromptIO({ inputs: [], isTTY: true });
    await expect(
      tryDriverSelect(driverThrowing(new PromptCancelledError()), io, {
        message: "Pick",
        choices: [{ value: "a" }],
      }),
    ).rejects.toBeInstanceOf(PromptCancelledError);
  });
});
