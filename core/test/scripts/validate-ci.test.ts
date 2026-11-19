import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("the CI gate reports abandoned and failed jobs and exits nonzero", () => {
  const result = Bun.spawnSync(
    [process.execPath, resolve(import.meta.dirname, "../../../scripts/validate-ci.ts")],
    {
      env: {
        ...process.env,
        CI_PROFILE: "providers",
        CI_BROAD: "false",
        CI_NEEDS: JSON.stringify({
          "process-signal-tests-darwin": { result: "abandoned", outputs: {} },
          "docs-build": { result: "failure" },
        }),
      },
    },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe("process-signal-tests-darwin: abandoned\ndocs-build: failure\n");
});
