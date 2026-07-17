import { afterEach, describe, expect, test } from "bun:test";

import { createOpenTuiPromptTestKit } from "./opentui-prompt-test-kit.ts";

describe("prompt chrome", () => {
  const { basePrompt, cleanup, flushInput, makeDriver, makeSetup, waitForBuild } =
    createOpenTuiPromptTestKit();

  afterEach(cleanup);

  test("baseline: message renders, answer semantics and inline validation are preserved", async () => {
    const selectSetup = await makeSetup();
    const selectDriver = await makeDriver(selectSetup);
    const selectAnswer = selectDriver.readRaw({
      prompt: { ...basePrompt, type: "select" },
      mode: "normal",
      choices: [
        { value: "vanilla", label: "Vanilla" },
        { value: "chocolate", label: "Chocolate" },
      ],
    });
    await waitForBuild(selectSetup);
    expect(selectSetup.captureCharFrame()).toContain("Choose a flavor");
    selectSetup.mockInput.pressArrow("down");
    await flushInput(selectSetup);
    selectSetup.mockInput.pressEnter();
    await flushInput(selectSetup);
    await expect(selectAnswer).resolves.toBe("2");

    const issueSetup = await makeSetup();
    const issueDriver = await makeDriver(issueSetup);
    const issueAnswer = issueDriver.readRaw({
      prompt: basePrompt,
      mode: "normal",
      issue: "must be lowercase",
    });
    await waitForBuild(issueSetup);
    expect(issueSetup.captureCharFrame()).toContain("must be lowercase");
    issueSetup.mockInput.pressEnter();
    await flushInput(issueSetup);
    await issueAnswer;
  });

  test("carries the message on the accented border title, not a separate interior row", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);
    const answer = driver.readRaw({ prompt: basePrompt, mode: "normal", defaultRaw: "vanilla" });
    await waitForBuild(testSetup);

    const [titleRow, ...bodyRows] = testSetup.captureCharFrame().split("\n");
    expect(titleRow).toContain("╭");
    expect(titleRow).toContain("Choose a flavor");
    const interiorMessageRows = bodyRows.filter(
      (row) => row.includes("Choose a flavor") && !row.includes("╭"),
    );
    expect(interiorMessageRows).toEqual([]);

    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await answer;
  });

  test("select shows an explicit indicator on the highlighted row and lists every choice", async () => {
    const selectIndicator = "▶";
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

    const rows = testSetup.captureCharFrame().split("\n");
    const vanillaRow = rows.find((row) => row.includes("Vanilla"));
    expect(vanillaRow).toBeDefined();
    expect(vanillaRow).toContain(selectIndicator);
    expect(rows.some((row) => row.includes("Chocolate"))).toBe(true);
    expect(rows.some((row) => /^\W*\d+\W*$/.test(row.trim()) && row.trim().length > 0)).toBe(false);

    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await answer;
  });

  test("keeps a Korean+emoji title visible and within width at 40 columns", async () => {
    const testSetup = await makeSetup(40, 10);
    const driver = await makeDriver(testSetup);
    const answer = driver.readRaw({
      prompt: { name: "n", type: "text", message: "한글 제목 매우 길어요 정말로 길다 🙂 끝" },
      mode: "normal",
    });
    await waitForBuild(testSetup);

    const titleRow = testSetup
      .captureCharFrame()
      .split("\n")
      .find((row) => row.includes("╭"));
    expect(titleRow).toBeDefined();
    expect(Bun.stringWidth((titleRow ?? "").replace(/\s+$/, ""))).toBeLessThanOrEqual(40);
    expect(titleRow).toContain("한글 제목");

    testSetup.mockInput.pressCtrlC();
    await flushInput(testSetup);
    await expect(answer).rejects.toMatchObject({ name: "PromptCancelledError" });
  });
});
