import { describe, expect, test } from "bun:test";

import { createOpenTuiPromptDriver } from "../src/opentui/prompt-driver.ts";
import {
  createOpenTuiPromptTestKit,
  makeAbortFixture,
  makeDestroyFailureFixture,
} from "./opentui-prompt-test-kit.ts";

describe("OpenTUI prompt driver lifecycle", () => {
  const { basePrompt, openTui } = createOpenTuiPromptTestKit();

  test("aborting an active read cancels and cleans the listener, renderer, and paint loop exactly once", async () => {
    const fixture = makeAbortFixture();
    const controller = new AbortController();
    let settled = false;
    const answer = fixture.driver
      .readRaw({ prompt: basePrompt, mode: "normal" }, controller.signal)
      .finally(() => {
        settled = true;
      });
    await fixture.listenerAttached;

    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const settledByAbort = settled;
    if (!settledByAbort) fixture.cancelByKey();

    await expect(answer).rejects.toMatchObject({ name: "PromptCancelledError" });
    expect(settledByAbort).toBe(true);
    expect(fixture.cleanup).toEqual({ listener: 1, renderer: 1, starts: 1 });
  });

  test("an already-aborted signal cancels before renderer creation", async () => {
    const controller = new AbortController();
    controller.abort();
    let createAttempts = 0;
    const driver = createOpenTuiPromptDriver({
      loadModule: async () => openTui,
      createRenderer: async () => {
        createAttempts += 1;
        throw new Error("renderer must not be created");
      },
    });

    await expect(
      driver.readRaw({ prompt: basePrompt, mode: "normal" }, controller.signal),
    ).rejects.toMatchObject({ name: "PromptCancelledError" });
    expect(createAttempts).toBe(0);
  });

  test("missing-native and unsupported-terminal fixtures each latch without another attempt", async () => {
    const attempts = { load: 0, init: 0 };
    const request = { prompt: basePrompt, mode: "normal" } as const;
    const moduleDriver = createOpenTuiPromptDriver({
      loadModule: async () => {
        attempts.load += 1;
        throw new Error("Cannot find package @opentui/core-linux-x64");
      },
    });
    const rendererDriver = createOpenTuiPromptDriver({
      loadModule: async () => openTui,
      createRenderer: async () => {
        attempts.init += 1;
        throw new Error("Unsupported terminal: dumb");
      },
    });

    await expect(moduleDriver.readRaw(request)).rejects.toHaveProperty(
      "name",
      "OpenTuiPromptUnavailableError",
    );
    await expect(moduleDriver.readRaw(request)).rejects.toHaveProperty(
      "name",
      "OpenTuiPromptUnavailableError",
    );
    await expect(rendererDriver.readRaw(request)).rejects.toHaveProperty(
      "name",
      "OpenTuiPromptUnavailableError",
    );
    await expect(rendererDriver.readRaw(request)).rejects.toHaveProperty(
      "name",
      "OpenTuiPromptUnavailableError",
    );
    expect(attempts).toEqual({ load: 1, init: 1 });
  });

  test("preserves cancellation when destroy also fails and latches the destroy failure", async () => {
    const fixture = makeDestroyFailureFixture(true);

    await expect(fixture.driver.readRaw({ prompt: basePrompt, mode: "normal" })).rejects.toMatchObject({
      name: "PromptCancelledError",
    });
    await expect(fixture.driver.readRaw({ prompt: basePrompt, mode: "normal" })).rejects.toMatchObject({
      name: "OpenTuiPromptUnavailableError",
    });
    expect(fixture.createAttempts()).toBe(1);
  });

  test("preserves a successful answer while latching destroy failure", async () => {
    const fixture = makeDestroyFailureFixture(false);

    await expect(fixture.driver.readRaw({ prompt: basePrompt, mode: "normal" })).resolves.toBe("answer");
    await expect(fixture.driver.readRaw({ prompt: basePrompt, mode: "normal" })).rejects.toMatchObject({
      name: "OpenTuiPromptUnavailableError",
      cause: fixture.destroyFailure,
    });
    expect(fixture.createAttempts()).toBe(1);
  });
});
