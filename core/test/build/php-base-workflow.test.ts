import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { renderPhpBaseWorkflow } from "../../../scripts/build-php-base-workflow.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const workflowPath = resolve(repoRoot, ".github/workflows/php-base-images.yml");

describe("PHP base image workflow", () => {
  test("committed workflow matches its generator and parses as YAML", async () => {
    const committed = await Bun.file(workflowPath).text();

    expect(committed).toBe(renderPhpBaseWorkflow());
    expect(() => Bun.YAML.parse(committed)).not.toThrow();
  });

  test("publishes every supported line to GHCR without changing runtime manifests", () => {
    const workflow = renderPhpBaseWorkflow();

    expect(workflow).toContain("php: [8.1, 8.2, 8.3, 8.4]");
    expect(workflow).toContain("registry: ghcr.io");
    expect(workflow).toContain("push: true");
    expect(workflow).toContain("images/php/${{ matrix.php }}");
    expect(workflow).not.toContain("plugins/service-lando/src/services/php.ts");
  });
});
