import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { buildPublicTranscript, parseGuideScenarioAst } from "../../../scripts/build-guide-scenarios.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const guidePath = "docs/guides/agent-native/mcp.mdx";
const readText = (path: string) => Bun.file(resolve(repoRoot, path)).text();

test("publishes the MCP guide INDEX rows as shipped", async () => {
  const index = await readText("docs/guides/INDEX.md");
  expect(index).toContain(
    "| BETA1-PRD-06 | US-398 | `lando mcp` setup and `--list` audit | `docs/guides/agent-native/mcp.mdx` | Shipped |",
  );
  expect(index).toContain(
    "| BETA1-PRD-14 | US-452 | MCP serve startup, refusal, bounded stdio, and read-only app config | `docs/guides/agent-native/mcp.mdx` | Shipped |",
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
