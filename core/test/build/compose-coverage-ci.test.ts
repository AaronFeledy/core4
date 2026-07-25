import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { renderCiWorkflow } from "../../../scripts/build-ci-workflow.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const workflowPath = resolve(repoRoot, ".github/workflows/ci.yml");

describe("compose coverage CI", () => {
  test("generated static checks run the compose coverage gate", async () => {
    const rendered = renderCiWorkflow();
    const committed = await Bun.file(workflowPath).text();

    for (const workflow of [rendered, committed]) {
      expect(workflow).toContain("- name: Compose schema coverage");
      expect(workflow).toContain("run: bun run check:compose-coverage");
    }
  });
});
