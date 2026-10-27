import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { Effect } from "effect";
import { buildBugReport } from "../../src/cli/bug-report.ts";
import {
  readSetupReadiness,
  setupReadinessPath,
  writeSetupReadiness,
} from "../../src/cli/commands/setup-readiness.ts";
import { safeOuterFailure } from "../../src/cli/outer-failure.ts";

const SECRET = "p5-seeded-env-canary-value-9f3a";
const ENV_KEY = "P5_DIAGNOSTIC_SECRET";

const seededEnv = (): Record<string, string | undefined> => ({ [ENV_KEY]: SECRET });

describe("P5 env-hub redaction", () => {
  test("bug report masks a seeded env secret in the body", () => {
    const sourceEnv = seededEnv();
    const redactor = createStandaloneRedactor("secrets", { sourceEnv });
    const report = buildBugReport({
      error: new Error(`provider failed with ${SECRET}`),
      context: { commandId: "app:start", cacheRoot: "/tmp/lando-p5-cache" },
      redactor,
    });
    expect(report.body).not.toContain(SECRET);
    expect(report.body).toContain("[redacted]");
  });

  test("setup readiness write masks a seeded env secret in evidence", async () => {
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-p5-setup-readiness-"));
    const previous = process.env[ENV_KEY];
    process.env[ENV_KEY] = SECRET;
    try {
      await Effect.runPromise(
        writeSetupReadiness(userDataRoot, "lando", [
          {
            id: "provider",
            status: "failed",
            evidence: `provider setup failed: ${SECRET}`,
            remediation: `fix ${SECRET}`,
          },
        ]),
      );
      const raw = await readFile(setupReadinessPath(userDataRoot), "utf-8");
      expect(raw).not.toContain(SECRET);
      expect(raw).toContain("[redacted]");
      const summary = await Effect.runPromise(readSetupReadiness(userDataRoot));
      expect(summary?.steps[0]?.evidence).not.toContain(SECRET);
    } finally {
      if (previous === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = previous;
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });

  test("outer failure returns the constant when redaction cannot load", async () => {
    const output = await safeOuterFailure(new Error(`${SECRET} leaked`), async () => {
      throw new Error("import-detail");
    });
    expect(output).toBe("Lando failed. Failure details could not be safely redacted.");
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain("import-detail");
  });

  test("outer failure masks a seeded env secret when redaction loads", async () => {
    const sourceEnv = seededEnv();
    const output = await safeOuterFailure(
      new Error(`crash with ${SECRET}`),
      () => {
        sourceEnv[ENV_KEY] = "replacement-environment-value";
        return import("@lando/redaction/service");
      },
      sourceEnv,
    );
    expect(output).not.toContain(SECRET);
    expect(output).toContain("[redacted]");
  });
});
