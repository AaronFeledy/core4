import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { buildPublicTranscript, parseGuideScenarioAst } from "../../../scripts/build-guide-scenarios.ts";
import { parseIndexRows } from "../../../scripts/check-guide-coverage.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const guidePath = "docs/guides/agent-native/mcp.mdx";
const readText = (path: string) => Bun.file(resolve(repoRoot, path)).text();

test("publishes the MCP guide INDEX rows as shipped", async () => {
  const rows = parseIndexRows(await readText("docs/guides/INDEX.md")).filter(
    (row) => row.guidePath === guidePath,
  );
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ prd: "BETA1-PRD-06", userStory: "US-398", status: "Shipped" }),
      expect.objectContaining({ prd: "BETA1-PRD-14", userStory: "US-452", status: "Shipped" }),
    ]),
  );
});

test("publishes the real catalog command, not the hidden startup refusal", async () => {
  const guide = parseGuideScenarioAst(guidePath, await readText(guidePath));
  const scenario = guide.scenarios.find(({ id }) => id === "startup-refusals");
  if (scenario === undefined) throw new Error("Missing startup refusal scenario");
  const transcript = buildPublicTranscript(guide, scenario, undefined);
  expect(transcript?.runtime).toBe("cli");
  expect(
    transcript?.frames.filter(({ kind }) => kind === "run").map(({ commandDisplay }) => commandDisplay),
  ).toEqual(["lando mcp --list --format=json"]);
});
