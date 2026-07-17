import { afterEach, describe, expect, test } from "bun:test";
import type { CliRenderer } from "@opentui/core";

import { createLiveRegionController } from "../src/opentui/live-region-controller.ts";
import { createOpenTuiPromptDriver } from "../src/opentui/prompt-driver.ts";
import { resetOpenTuiSubstrateAvailabilityForTests } from "../src/opentui/substrate-availability.ts";
import { createOpenTuiPromptTestKit } from "./opentui-prompt-test-kit.ts";

describe("OpenTUI prompt driver", () => {
  const { basePrompt, cleanup, flushInput, makeDriver, makeSetup, openTui, waitForBuild } =
    createOpenTuiPromptTestKit();

  afterEach(() => {
    cleanup();
    resetOpenTuiSubstrateAvailabilityForTests();
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

  test("confirm tab-select returns y or n", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);

    const noAnswer = driver.readRaw({
      prompt: { ...basePrompt, type: "confirm" },
      mode: "confirm",
      defaultRaw: "yes",
    });
    await waitForBuild(testSetup);
    testSetup.mockInput.pressArrow("right");
    await flushInput(testSetup);
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await expect(noAnswer).resolves.toBe("n");

    const testSetup2 = await makeSetup();
    const driver2 = await makeDriver(testSetup2);
    const yesAnswer = driver2.readRaw({
      prompt: { ...basePrompt, type: "confirm" },
      mode: "confirm",
      defaultRaw: "no",
    });
    await waitForBuild(testSetup2);
    testSetup2.mockInput.pressArrow("left");
    await flushInput(testSetup2);
    testSetup2.mockInput.pressEnter();
    await flushInput(testSetup2);
    await expect(yesAnswer).resolves.toBe("y");
  });

  test("confirm pre-selects No without an affirmative default", async () => {
    // No default: pressing Enter must NOT submit "y" — mirrors the line-based
    // [y/N]/(y/n) reader where blank input is never affirmative (security: plugin
    // trust and unverified tarball installs must not proceed on Enter alone).
    const noDefault = await makeSetup();
    const noDefaultDriver = await makeDriver(noDefault);
    const noDefaultAnswer = noDefaultDriver.readRaw({
      prompt: { ...basePrompt, type: "confirm" },
      mode: "confirm",
    });
    await waitForBuild(noDefault);
    noDefault.mockInput.pressEnter();
    await flushInput(noDefault);
    await expect(noDefaultAnswer).resolves.toBe("n");

    const falseDefault = await makeSetup();
    const falseDriver = await makeDriver(falseDefault);
    const falseAnswer = falseDriver.readRaw({
      prompt: { ...basePrompt, type: "confirm" },
      mode: "confirm",
      defaultRaw: "false",
    });
    await waitForBuild(falseDefault);
    falseDefault.mockInput.pressEnter();
    await flushInput(falseDefault);
    await expect(falseAnswer).resolves.toBe("n");

    const yesDefault = await makeSetup();
    const yesDriver = await makeDriver(yesDefault);
    const yesAnswer = yesDriver.readRaw({
      prompt: { ...basePrompt, type: "confirm" },
      mode: "confirm",
      defaultRaw: "yes",
    });
    await waitForBuild(yesDefault);
    yesDefault.mockInput.pressEnter();
    await flushInput(yesDefault);
    await expect(yesAnswer).resolves.toBe("y");
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
    await expect(
      createLiveRegionController(
        {
          stdout: process.stdout,
          width: 80,
          height: 24,
          footerHeight: 12,
        },
        {
          loadModule: async () => {
            throw substrateFailure;
          },
        },
      ),
    ).rejects.toHaveProperty("name", "OpenTuiLiveRegionUnavailableError");
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
