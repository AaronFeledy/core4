import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Cause, Effect, Exit } from "effect";
import { rewriteScenarioSourceMappedOutput } from "../../../scripts/test-reporters/scenario-source-mapper";
import { shellFailureCases } from "../_support/shell-failure-characterization";
import { withEnvVar } from "../_support/temp-cwd";

const repoRoot = resolve(import.meta.dirname, "../../..");
const generated =
  "core/test/scenarios/reporter/fixtures/test/scenarios/generated/guides/source-map-guide/runs.fixture.ts";

describe("scenario reporter shell failure characterization", () => {
  for (const scenario of shellFailureCases) {
    test(`maps the real ${scenario.kind} failure cause`, async () => {
      // Given
      const exit = await Effect.runPromiseExit(scenario.effect());
      if (!Exit.isFailure(exit)) throw new Error("Expected failure");
      const input = `${Cause.pretty(exit.cause)
        .replaceAll(/fiber \(#\d+\)/g, "fiber (#<id>)")
        .replaceAll(
          "at <fixture>",
          `at ${repoRoot}/${generated}:19:13`,
        )}\n(fail) source-map-guide:runs [<time>]\n`;

      // When
      const output = await withEnvVar("GITHUB_ACTIONS", "false", async () =>
        rewriteScenarioSourceMappedOutput(input, { repoRoot }),
      );

      // Then: render every failure and its stack, not runPromise's lossy squash.
      const prefix = scenario.kind === "interrupt" ? "" : "[source-map-guide:runs] ";
      const failureText =
        scenario.kind === "interrupt"
          ? "InterruptError: All fibers interrupted without error {\n  [cause]: InterruptCause: The fiber was interrupted by:\n      at fiber (#<id>)\n}"
          : scenario.causeText.replace(
              "\nError: cleanup defect",
              "\n[source-map-guide:runs] Error: cleanup defect",
            );
      const mapped = failureText.replaceAll(
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
    expect(stdout + stderr).toContain("[source-map-guide:runs] error: Error: seeded failure");
    expect(stdout + stderr).toContain("[source-map-guide:runs] Error: cleanup defect");
    expect(
      (stdout + stderr).match(/at docs\/guides\/source-map-guide\.mdx:9/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(stdout + stderr).toContain(`Generated: ${generated}:19:`);
    expect(stdout + stderr).toContain("Re-run: bun run docs:scenario source-map-guide --scenario runs");
    expect(stdout + stderr).toMatch(/0 pass\s+1 fail/);
  }, 15_000);
});
