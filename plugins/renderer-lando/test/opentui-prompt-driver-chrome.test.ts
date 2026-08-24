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

  test("prefilled text default is selected so typing replaces it", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);
    const answer = driver.readRaw({ prompt: basePrompt, mode: "normal", defaultRaw: "vanilla" });
    await waitForBuild(testSetup);

    await testSetup.mockInput.typeText("x");
    await flushInput(testSetup);
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await expect(answer).resolves.toBe("x");
  });

  test("renders caller-supplied help under the input", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);
    const help = "HELP_TOKEN_site-id";
    const answer = driver.readRaw({ prompt: basePrompt, mode: "normal", help });
    await waitForBuild(testSetup);

    expect(testSetup.captureCharFrame()).toContain(help);

    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await answer;
  });

  test("live footer updates from the current input value", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);
    const answer = driver.readRaw({
      prompt: basePrompt,
      mode: "normal",
      defaultRaw: "alpha",
      footer: [{ id: "slug", render: (raw: string) => `slug:${raw}` }],
    });
    await waitForBuild(testSetup);
    expect(testSetup.captureCharFrame()).toContain("slug:alpha");

    await testSetup.mockInput.typeText("beta");
    await flushInput(testSetup);
    expect(testSetup.captureCharFrame()).toContain("slug:beta");

    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await expect(answer).resolves.toBe("beta");
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

  const describedChoices = [
    { label: "Vanilla", description: "cold" },
    { label: "Chocolate", description: "rich" },
  ];

  const readDescribed = (driver: Awaited<ReturnType<typeof makeDriver>>) =>
    driver.readRaw({
      prompt: { ...basePrompt, type: "select" },
      mode: "normal",
      choices: describedChoices,
    });

  test("described select shows titles and selected preview, then submits original index", async () => {
    const testSetup = await makeSetup(80, 24);
    const driver = await makeDriver(testSetup);
    const answer = readDescribed(driver);
    await waitForBuild(testSetup);

    const first = testSetup.captureCharFrame();
    expect(first).toContain("Vanilla");
    expect(first).toContain("Chocolate");
    expect(first).toContain("cold");
    expect(first).not.toContain("Vanilla —");

    testSetup.mockInput.pressArrow("down");
    await flushInput(testSetup);
    const afterDown = testSetup.captureCharFrame();
    expect(afterDown).toContain("rich");
    expect(afterDown).not.toContain("cold");

    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await expect(answer).resolves.toBe("2");
  });

  test("side preview repeats a list-clipped title above the description", async () => {
    const longTitle = "Node + programmatic Landofile";
    const testSetup = await makeSetup(80, 24);
    const driver = await makeDriver(testSetup);
    const answer = driver.readRaw({
      prompt: { ...basePrompt, type: "select" },
      mode: "normal",
      choices: [
        { label: longTitle, description: "advanced demo" },
        { label: "Toolbox", description: "tool runner" },
      ],
    });
    await waitForBuild(testSetup);

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain(longTitle);
    expect(frame).toContain("advanced demo");

    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await expect(answer).resolves.toBe("1");
  });

  test("stacked described select puts the preview below titles", async () => {
    const testSetup = await makeSetup(50, 24);
    const driver = await makeDriver(testSetup);
    const answer = readDescribed(driver);
    await waitForBuild(testSetup);

    const rows = testSetup.captureCharFrame().split("\n");
    const titleRow = Math.max(
      rows.findIndex((row) => row.includes("Vanilla")),
      rows.findIndex((row) => row.includes("Chocolate")),
    );
    const previewRow = rows.findIndex((row) => row.includes("cold"));
    expect(titleRow).toBeGreaterThanOrEqual(0);
    expect(previewRow).toBeGreaterThan(titleRow);

    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await expect(answer).resolves.toBe("1");
  });

  test("hidden described select keeps titles and omits the preview", async () => {
    const testSetup = await makeSetup(60, 12);
    const driver = await makeDriver(testSetup);
    const answer = readDescribed(driver);
    await waitForBuild(testSetup);

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Vanilla");
    expect(frame).not.toContain("cold");

    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await expect(answer).resolves.toBe("1");
  });

  test("undescribed select stays titles-only without a planted preview word", async () => {
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

    expect(testSetup.captureCharFrame()).not.toContain("cold");

    testSetup.mockInput.pressArrow("down");
    await flushInput(testSetup);
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await expect(answer).resolves.toBe("2");
  });

  test("resize keeps the highlighted described choice", async () => {
    const testSetup = await makeSetup(50, 24);
    const driver = await makeDriver(testSetup);
    const answer = readDescribed(driver);
    await waitForBuild(testSetup);

    testSetup.mockInput.pressArrow("down");
    await flushInput(testSetup);
    testSetup.resize(80, 24);
    await testSetup.renderOnce();

    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await expect(answer).resolves.toBe("2");
  });

  test("type-to-filter ranks titles and submits the original index", async () => {
    const testSetup = await makeSetup(80, 24);
    const driver = await makeDriver(testSetup);
    const answer = readDescribed(driver);
    await waitForBuild(testSetup);

    await testSetup.mockInput.typeText("cho");
    await flushInput(testSetup);
    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Chocolate");
    expect(frame).not.toContain("Vanilla");

    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await expect(answer).resolves.toBe("2");
  });

  test("empty filter does not submit and backspace restores the catalog", async () => {
    const testSetup = await makeSetup(80, 24);
    const driver = await makeDriver(testSetup);
    let resolved = false;
    const answer = readDescribed(driver).then((value) => {
      resolved = true;
      return value;
    });
    await waitForBuild(testSetup);

    await testSetup.mockInput.typeText("zzz");
    await flushInput(testSetup);
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    expect(resolved).toBe(false);

    testSetup.mockInput.pressBackspace();
    testSetup.mockInput.pressBackspace();
    testSetup.mockInput.pressBackspace();
    await flushInput(testSetup);
    const restored = testSetup.captureCharFrame();
    expect(restored).toContain("Vanilla");
    expect(restored).toContain("Chocolate");

    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await expect(answer).resolves.toBe("1");
  });
});
