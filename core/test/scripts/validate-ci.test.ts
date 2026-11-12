import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { CiProfile } from "../../../scripts/ci-selection.ts";

const root = resolve(import.meta.dirname, "../../..");

const runGate = (needs: unknown, profile: CiProfile = "providers", broad = false) => {
  const child = Bun.spawnSync([process.execPath, resolve(root, "scripts/validate-ci.ts")], {
    cwd: root,
    env: {
      ...process.env,
      CI_PROFILE: profile,
      CI_BROAD: String(broad),
      CI_NEEDS: JSON.stringify(needs),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: child.exitCode, stderr: child.stderr.toString().trim() };
};

describe("CI result gate", () => {
  test("reports the captured abandoned matrix result instead of a decoder error", () => {
    // Observed entry from run 40763314140, job 123099627481; not the full needs payload.
    const needs = { "process-signal-tests-darwin": { result: "abandoned", outputs: {} } };
    expect(runGate(needs)).toEqual({
      exitCode: 1,
      stderr: "process-signal-tests-darwin: abandoned",
    });
  });

  test.each(["abandoned", "cancelled", "failure", "skipped"])(
    "fails selected jobs with result %s, including broad selection",
    (result) => {
      const needs = { "process-signal-tests-darwin": { result } };
      for (const [profile, broad] of [
        ["runtime", false],
        ["providers", false],
        ["docs", true],
      ] as const) {
        expect(runGate(needs, profile, broad)).toEqual({
          exitCode: 1,
          stderr: `process-signal-tests-darwin: ${result}`,
        });
      }
    },
  );

  test.each(["abandoned", "cancelled", "failure"])("does not hide %s on a policy-excluded job", (result) => {
    expect(runGate({ "process-signal-tests-darwin": { result } }, "docs")).toEqual({
      exitCode: 1,
      stderr: `process-signal-tests-darwin: ${result}`,
    });
  });

  test("allows successful results and only policy-excluded skips", () => {
    expect(
      runGate(
        {
          selection: { result: "success" },
          "docs-build": { result: "success" },
          "process-signal-tests-darwin": { result: "skipped" },
        },
        "docs",
      ),
    ).toEqual({ exitCode: 0, stderr: "" });
  });

  test("reports other failures alongside an abandoned job", () => {
    expect(
      runGate({
        "process-signal-tests-darwin": { result: "abandoned", outputs: {} },
        "docs-build": { result: "failure" },
      }),
    ).toEqual({
      exitCode: 1,
      stderr: "process-signal-tests-darwin: abandoned\ndocs-build: failure",
    });
  });

  test("still rejects unrecognized results", () => {
    expect(runGate({ "docs-build": { result: "unrecognized" } }).exitCode).not.toBe(0);
  });

  test("still rejects unknown jobs", () => {
    expect(runGate({ surprise: { result: "success" } })).toEqual({
      exitCode: 1,
      stderr: "unknown job: surprise",
    });
  });
});
