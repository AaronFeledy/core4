import { afterEach, describe, expect, test } from "bun:test";
import type { CliRenderer } from "@opentui/core";

import { createLiveRegionController } from "../src/opentui/live-region-controller.ts";
import { resetLiveRegionModuleCacheForTests } from "../src/opentui/live-region-substrate.ts";
import { createOpenTuiPromptDriver } from "../src/opentui/prompt-driver.ts";
import { resetOpenTuiSubstrateAvailabilityForTests } from "../src/opentui/substrate-availability.ts";
import { createOpenTuiPromptTestKit } from "./opentui-prompt-test-kit.ts";

describe("OpenTUI prompt driver", () => {
  const { basePrompt, cleanup, flushInput, makeDriver, makeSetup, openTui, waitForBuild } =
    createOpenTuiPromptTestKit();

  afterEach(() => {
    cleanup();
    resetOpenTuiSubstrateAvailabilityForTests();
    resetLiveRegionModuleCacheForTests();
  });

  test("select returns a 1-based index after keyboard navigation", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);

    const answer = driver.readRaw({
      prompt: { ...basePrompt, type: "select" },
      mode: "normal",
      choices: [
        { value: "vanilla", label: "Vanilla" },
        { value: "chocolate", label: "Chocolate" },
      ],
    });
    await waitForBuild(testSetup);
    testSetup.mockInput.pressArrow("down");
    await flushInput(testSetup);
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);

    await expect(answer).resolves.toBe("2");
  });

  test("select pre-highlights prompt.default when defaultRaw is omitted", async () => {
    // tryDriverSelect (incl. `lando setup` provider pick) carries the intended
    // default on prompt.default and omits defaultRaw. Pressing Enter without
    // navigation must submit the resolved default's row, not index 0.
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);

    const choices = [
      { value: "vanilla", label: "Vanilla" },
      { value: "chocolate", label: "Chocolate" },
      { value: "strawberry", label: "Strawberry" },
    ];
    const answer = driver.readRaw({
      prompt: { ...basePrompt, type: "select", choices, default: "strawberry" },
      mode: "normal",
      choices,
    });
    await waitForBuild(testSetup);
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);

    await expect(answer).resolves.toBe("3");
  });

  test.each([
    { type: "confirm", mode: "normal", defaultRaw: "false" },
    { type: "confirm", mode: "normal", defaultRaw: "true" },
    { type: "text", mode: "confirm", defaultRaw: "no" },
    { type: "confirm", mode: "confirm" },
    { type: "secret", mode: "normal" },
  ])("declines %j before native loading or renderer creation", async (request) => {
    // Given a loader that must not be needed by the canonical line-input types.
    let loads = 0;
    let creates = 0;
    const driver = createOpenTuiPromptDriver({
      loadModule: async () => {
        loads++;
        throw new TypeError("Unexpected native load");
      },
      createRenderer: async () => {
        creates++;
        throw new TypeError("Unexpected renderer creation");
      },
    });

    // When the rich driver is offered a line-input capability.
    await expect(
      driver.readRaw({ ...request, prompt: { ...basePrompt, type: request.type } }),
    ).rejects.toBeInstanceOf(Error);

    // Then neither native loading nor terminal ownership is acquired.
    expect({ loads, creates }).toEqual({ loads: 0, creates: 0 });
  });

  test("input accepts default on enter and typed values", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);

    const defaultAnswer = driver.readRaw({ prompt: basePrompt, mode: "normal", defaultRaw: "vanilla" });
    await waitForBuild(testSetup);
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await expect(defaultAnswer).resolves.toBe("vanilla");

    const testSetup2 = await makeSetup();
    const driver2 = await makeDriver(testSetup2);
    const typedAnswer = driver2.readRaw({ prompt: basePrompt, mode: "normal" });
    await waitForBuild(testSetup2);
    await testSetup2.mockInput.typeText("mint");
    await flushInput(testSetup2);
    testSetup2.mockInput.pressEnter();
    await flushInput(testSetup2);
    await expect(typedAnswer).resolves.toBe("mint");
  });

  test("textarea submits multi-line answers", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);

    const answer = driver.readRaw({ prompt: { ...basePrompt, type: "textarea" }, mode: "normal" });
    await waitForBuild(testSetup);
    await testSetup.mockInput.typeText("line one");
    await flushInput(testSetup);
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await testSetup.mockInput.typeText("line two");
    await flushInput(testSetup);
    testSetup.mockInput.pressEnter({ meta: true });
    await flushInput(testSetup);

    await expect(answer).resolves.toBe("line one\nline two");
  });

  test("renders inline validation issue", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);

    const answer = driver.readRaw({ prompt: basePrompt, mode: "normal", issue: "must be lowercase" });
    await waitForBuild(testSetup);

    expect(testSetup.captureCharFrame()).toContain("must be lowercase");
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await answer;
  });

  test("cancels with PromptCancelledError on Ctrl-C or Escape", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);

    const ctrlCAnswer = driver.readRaw({ prompt: basePrompt, mode: "normal" });
    await waitForBuild(testSetup);
    testSetup.mockInput.pressCtrlC();
    await flushInput(testSetup);
    await expect(ctrlCAnswer).rejects.toMatchObject({ name: "PromptCancelledError" });

    const testSetup2 = await makeSetup();
    const driver2 = await makeDriver(testSetup2);
    const escAnswer = driver2.readRaw({ prompt: basePrompt, mode: "normal" });
    await waitForBuild(testSetup2);
    testSetup2.mockInput.pressEscape();
    await flushInput(testSetup2);
    await expect(escAnswer).rejects.toMatchObject({ name: "PromptCancelledError" });
  });

  test("survives test renderer resize and still resolves", async () => {
    const testSetup = await makeSetup(40, 8);
    const driver = await makeDriver(testSetup);

    const answer = driver.readRaw({ prompt: basePrompt, mode: "normal", defaultRaw: "resized" });
    await waitForBuild(testSetup);
    testSetup.resize(80, 16);
    await testSetup.renderOnce();
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);

    await expect(answer).resolves.toBe("resized");
  });

  test("declines secret before creating a renderer", async () => {
    let created = false;
    const driver = createOpenTuiPromptDriver<CliRenderer>({
      loadModule: async () => openTui,
      createRenderer: async () => {
        created = true;
        throw new Error("should not create renderer");
      },
    });

    await expect(
      driver.readRaw({ prompt: { ...basePrompt, type: "secret" }, mode: "normal" }),
    ).rejects.toThrow("driver declines secret");
    expect(created).toBe(false);
  });

  test("a live-region failure prevents a later prompt driver from loading OpenTUI", async () => {
    const substrateFailure = new Error("no native binding");
    let promptLoadAttempts = 0;
    const controller = await createLiveRegionController(
      {
        stdout: process.stdout,
        width: 80,
        height: 24,
      },
      {
        loadModule: async () => {
          throw substrateFailure;
        },
      },
    );
    await expect(controller.enterFullTail()).rejects.toHaveProperty(
      "name",
      "OpenTuiLiveRegionUnavailableError",
    );
    await controller.dispose().catch(() => undefined);
    const driver = createOpenTuiPromptDriver({
      loadModule: async () => {
        promptLoadAttempts += 1;
        throw new Error("prompt loader must not run");
      },
    });

    await expect(driver.readRaw({ prompt: basePrompt, mode: "normal" })).rejects.toMatchObject({
      name: "OpenTuiPromptUnavailableError",
      cause: substrateFailure,
    });
    expect(promptLoadAttempts).toBe(0);
  });
});
