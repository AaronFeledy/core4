import { describe, expect, test } from "bun:test";
import { MCP_DEFAULT_ALLOWLIST } from "@lando/mcp/generated-allowlist";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { identityRedactor } from "@lando/sdk/command-result";
import { Effect, Layer } from "effect";
import type { DoctorSectionResult } from "../../src/cli/commands/doctor-contract";
import {
  DefaultMcpDoctorLayer,
  MCP_DOCTOR_CANARY_SECRET,
  isMcpDefaultAllowlistFresh,
  mcpDoctor,
} from "../../src/cli/commands/doctor-mcp.ts";
import { renderDoctorReportAsNdjson } from "../../src/cli/commands/doctor-render-ndjson.ts";
import { renderDoctorReport } from "../../src/cli/commands/doctor-render-text.ts";
import { makeDoctorReport } from "../../src/cli/commands/doctor-report.ts";

const runWithDefault = (): Promise<DoctorSectionResult> =>
  Effect.runPromise(mcpDoctor().pipe(Effect.provide(DefaultMcpDoctorLayer)));

const identityRedactionLayer = Layer.succeed(
  RedactionService,
  RedactionService.of({
    ...makeRedactionService(),
    payloadValues: () => Effect.succeed(() => ({ substring: [], wholeToken: [] })),
    forProfile: () => Effect.succeed(identityRedactor),
  }),
);

describe("mcpDoctor", () => {
  test("reports a passing MCP check when allowlist, catalog, and canary round-trip all succeed", async () => {
    const result = await runWithDefault();
    expect(result.checks).toHaveLength(1);
    const check = result.checks[0];
    expect(check).toBeDefined();
    if (check === undefined) return;
    expect(check.name).toBe("mcp");
    expect(check.status).toBe("pass");
    expect(check.severity).toBe("info");
    expect(check.solutions).toHaveLength(0);
    expect(check.context.allowlistFresh).toBe("true");
    expect(check.context.catalogGenerated).toBe("true");
    expect(check.context.canaryRoundTrip).toBe("true");
    expect(check.context.canaryRedacted).toBe("true");
    expect(Number(check.context.allowlistSize)).toBeGreaterThan(0);
    expect(Number(check.context.catalogTools)).toBeGreaterThan(0);
  });

  test("detects generated default allowlist cache integrity drift", () => {
    expect(isMcpDefaultAllowlistFresh(MCP_DEFAULT_ALLOWLIST)).toBe(true);
    expect(isMcpDefaultAllowlistFresh([])).toBe(false);
    expect(isMcpDefaultAllowlistFresh(["app:exec"])).toBe(false);
    expect(isMcpDefaultAllowlistFresh([...MCP_DEFAULT_ALLOWLIST].reverse())).toBe(false);
  });

  test("never leaks the canary secret into the check output", async () => {
    const result = await runWithDefault();
    expect(JSON.stringify(result)).not.toContain(MCP_DOCTOR_CANARY_SECRET);
  });

  test("fails the check when the canary secret is not redacted", async () => {
    const result = await Effect.runPromise(mcpDoctor().pipe(Effect.provide(identityRedactionLayer)));
    const check = result.checks[0];
    expect(check).toBeDefined();
    if (check === undefined) return;
    expect(check.status).toBe("fail");
    expect(check.severity).toBe("error");
    expect(check.context.canaryRedacted).toBe("false");
    expect(check.solutions.length).toBeGreaterThan(0);
    expect(check.solutions.map((solution) => solution.description).join("\n")).not.toContain("mcp.allow");
    // Even on a redaction failure, the check must not echo the raw secret.
    expect(JSON.stringify(result)).not.toContain(MCP_DOCTOR_CANARY_SECRET);
  });

  test("renders a human-readable line and an NDJSON doctor.check event", async () => {
    const result = await runWithDefault();
    const report = makeDoctorReport({
      version: "4.0.0-test",
      checks: result.checks.map((finding) => ({ section: "mcp" as const, ...finding })),
      skipped: [],
    });
    expect(renderDoctorReport(report, undefined, { all: true })).toContain("mcp: pass");
    const ndjson = renderDoctorReportAsNdjson(report);
    expect(ndjson).toContain('"event":"doctor.check"');
    expect(ndjson).toContain('"name":"mcp"');
    expect(ndjson).not.toContain(MCP_DOCTOR_CANARY_SECRET);
  });
});
