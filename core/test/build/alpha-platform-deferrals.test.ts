import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");

const readText = async (path: string): Promise<string> => Bun.file(resolve(repoRoot, path)).text();

describe("alpha platform deferrals", () => {
  test("mirrors roadmap multi-platform CI deferrals in PRD non-goals and runbook docs", async () => {
    const roadmap = await readText("spec/ROADMAP.md");
    const alphaIndex = await readText("spec/alpha/prd-alpha-00-index.md");
    const ciPrd = await readText("spec/alpha/prd-alpha-07-ci-distribution-and-release-channel.md");
    const runbook = await readText("docs/ci-runbook.md");

    expect(roadmap).toContain(
      "Alpha defers: multi-platform matrix (Beta), nightly cron (Beta), weekly provider matrix (Beta).",
    );
    expect(alphaIndex).toContain(
      "Multi-platform release matrix beyond Linux x64 dev prerelease and explicitly scoped macOS Alpha validation.",
    );

    expect(ciPrd).toContain("Broad multi-platform CI/release matrix");
    expect(ciPrd).toContain("Windows and linux-arm64 release targets");
    expect(ciPrd).toContain("Nightly cron and weekly provider matrix");
    expect(ciPrd).toContain("macOS provider-lando validation is manual QA or an explicit opt-in job");

    expect(runbook).toContain("Default Alpha CI is Linux x64 only");
    expect(runbook).toContain("No Windows or linux-arm64 release matrix is generated in Alpha");
    expect(runbook).toContain("macOS provider-lando validation is manual QA or an explicit opt-in job");
  });
});
