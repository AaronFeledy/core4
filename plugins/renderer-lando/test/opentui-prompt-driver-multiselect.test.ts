import { afterEach, describe, expect, test } from "bun:test";

import { createOpenTuiPromptTestKit } from "./opentui-prompt-test-kit.ts";

describe("OpenTUI prompt driver — multiselect", () => {
  const { basePrompt, cleanup, flavors, flushInput, makeDriver, makeSetup, waitForBuild } =
    createOpenTuiPromptTestKit();

  afterEach(cleanup);

  test("toggles focused rows with Space and submits ascending 1-based indices on Enter", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);
    const answer = driver.readRaw({
      prompt: { ...basePrompt, type: "multiselect", choices: flavors },
      mode: "normal",
      choices: flavors,
    });
    await waitForBuild(testSetup);
    testSetup.mockInput.pressKey(" ");
    await flushInput(testSetup);
    testSetup.mockInput.pressArrow("down");
    await flushInput(testSetup);
    testSetup.mockInput.pressArrow("down");
    await flushInput(testSetup);
    testSetup.mockInput.pressKey(" ");
    await flushInput(testSetup);
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);

    await expect(answer).resolves.toBe("1,3");
  });

  test("renders the focused-row cursor and persistent checked-state indicators", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);
    const answer = driver.readRaw({
      prompt: { ...basePrompt, type: "multiselect", choices: flavors },
      mode: "normal",
      choices: flavors,
    });
    await waitForBuild(testSetup);
    testSetup.mockInput.pressKey(" ");
    await flushInput(testSetup);

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("▶");
    expect(frame).toContain("[x] Vanilla");
    expect(frame).toContain("[ ] Chocolate");

    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await answer;
  });

  test("empty selection submits an empty string", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);
    const answer = driver.readRaw({
      prompt: { ...basePrompt, type: "multiselect", choices: flavors },
      mode: "normal",
      choices: flavors,
    });
    await waitForBuild(testSetup);
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);

    await expect(answer).resolves.toBe("");
  });

  test("pre-checks defaultRaw indices and submits them when unchanged", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);
    const answer = driver.readRaw({
      prompt: { ...basePrompt, type: "multiselect", choices: flavors },
      mode: "normal",
      choices: flavors,
      defaultRaw: "1,3",
    });
    await waitForBuild(testSetup);

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("[x] Vanilla");
    expect(frame).toContain("[ ] Chocolate");
    expect(frame).toContain("[x] Strawberry");

    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await expect(answer).resolves.toBe("1,3");
  });

  test("cancels with PromptCancelledError on Ctrl-C", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);
    const answer = driver.readRaw({
      prompt: { ...basePrompt, type: "multiselect", choices: flavors },
      mode: "normal",
      choices: flavors,
    });
    await waitForBuild(testSetup);
    testSetup.mockInput.pressCtrlC();
    await flushInput(testSetup);

    await expect(answer).rejects.toMatchObject({ name: "PromptCancelledError" });
  });

  test("pre-checks value and label defaultRaw tokens, mirroring runtime matching", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);
    const answer = driver.readRaw({
      prompt: { ...basePrompt, type: "multiselect", choices: flavors },
      mode: "normal",
      choices: flavors,
      defaultRaw: "vanilla,Strawberry",
    });
    await waitForBuild(testSetup);

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("[x] Vanilla");
    expect(frame).toContain("[ ] Chocolate");
    expect(frame).toContain("[x] Strawberry");

    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await expect(answer).resolves.toBe("1,3");
  });

  test("restores the keypress listener count to baseline after Enter settlement", async () => {
    const testSetup = await makeSetup();
    const baseline = testSetup.renderer.keyInput.listenerCount("keypress");
    const driver = await makeDriver(testSetup);
    const answer = driver.readRaw({
      prompt: { ...basePrompt, type: "multiselect", choices: flavors },
      mode: "normal",
      choices: flavors,
    });
    await waitForBuild(testSetup);
    testSetup.mockInput.pressKey(" ");
    await flushInput(testSetup);
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await expect(answer).resolves.toBe("1");

    expect(testSetup.renderer.keyInput.listenerCount("keypress")).toBe(baseline);
  });

  test("restores the keypress listener count to baseline after Ctrl-C cancellation", async () => {
    const testSetup = await makeSetup();
    const baseline = testSetup.renderer.keyInput.listenerCount("keypress");
    const driver = await makeDriver(testSetup);
    const answer = driver.readRaw({
      prompt: { ...basePrompt, type: "multiselect", choices: flavors },
      mode: "normal",
      choices: flavors,
    });
    await waitForBuild(testSetup);
    testSetup.mockInput.pressCtrlC();
    await flushInput(testSetup);
    await expect(answer).rejects.toMatchObject({ name: "PromptCancelledError" });

    expect(testSetup.renderer.keyInput.listenerCount("keypress")).toBe(baseline);
  });
});
