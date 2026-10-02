import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Effect } from "effect";
import { rewriteScenarioSourceMappedOutput } from "../../../scripts/test-reporters/scenario-source-mapper";
import { shellFailureCases } from "../_support/shell-failure-characterization";
import { withEnvVar } from "../_support/temp-cwd";

const repoRoot = resolve(import.meta.dirname, "../../..");
const generated =
  "core/test/scenarios/reporter/fixtures/test/scenarios/generated/guides/source-map-guide/runs.fixture.ts";

describe("scenario reporter shell failure characterization", () => {
  for (const scenario of shellFailureCases) {
    test(`maps the real ${scenario.kind} rejection text`, async () => {
      // Given
      const rejection: unknown = await Effect.runPromise(scenario.effect()).then(
        () => {
          throw new Error("Expected rejection");
        },
        (error: unknown) => error,
      );
      const input = `${String(rejection).replaceAll("at <fixture>", `at ${repoRoot}/${generated}:19:13`)}\n(fail) source-map-guide:runs [<time>]\n`;

      // When
      const output = await withEnvVar("GITHUB_ACTIONS", "false", async () =>
        rewriteScenarioSourceMappedOutput(input, { repoRoot }),
      );

      // Then: only the defect's '(FiberFailure) Error:' line currently gets a guide prefix.
      const prefix = scenario.kind === "defect" ? "[source-map-guide:runs] " : "";
      const mapped = scenario.rejectionText.replaceAll(
        "    at <fixture>",
        `    at docs/guides/source-map-guide.mdx:9\n    Generated: ${generated}:19:13`,
      );
      const rerun =
        scenario.kind === "interrupt"
          ? ""
          : "Re-run: bun run docs:scenario source-map-guide --scenario runs\n";
      expect(output).toBe(`${prefix}${mapped}\n(fail) source-map-guide:runs [<time>]\n${rerun}`);
    });
  }

  test("the scenario wrapper preserves a rejected Effect's exit code", async () => {
    // Given
    const wrapper = resolve(repoRoot, "scripts/test-reporters/run-guide-scenarios.ts");
    // When
    const child = Bun.spawn([process.execPath, wrapper, resolve(repoRoot, generated)], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_ACTIONS: "false",
        LANDO_DISABLE_GUIDE_SOURCE_MAPPER: "0",
        LANDO_GUIDE_SCENARIO_LIVE_OUTPUT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    // Then
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("(FiberFailure) Error: seeded failure");
    expect(stdout + stderr).toContain("[source-map-guide:runs] error: seeded failure");
    expect(stdout + stderr).toContain("Re-run: bun run docs:scenario source-map-guide --scenario runs");
    expect(stdout + stderr).toMatch(/0 pass\s+1 fail/);
  }, 15_000);
});
