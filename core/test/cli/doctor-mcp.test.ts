import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import {
  DefaultMcpDoctorLayer,
  MCP_DOCTOR_CANARY_SECRET,
  type McpDoctorResult,
  mcpDoctor,
  renderMcpDoctorResult,
  renderMcpDoctorResultAsNdjson,
} from "../../src/cli/commands/doctor-mcp.ts";
import { identityRedactor } from "../../src/cli/result-encode.ts";
import { RedactionService } from "../../src/redaction/service.ts";

const runWithDefault = (): Promise<McpDoctorResult> =>
  Effect.runPromise(mcpDoctor().pipe(Effect.provide(DefaultMcpDoctorLayer)));

const identityRedactionLayer = Layer.succeed(RedactionService, {
  forProfile: () => Effect.succeed(identityRedactor),
});

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
    // Even on a redaction failure, the check must not echo the raw secret.
    expect(JSON.stringify(result)).not.toContain(MCP_DOCTOR_CANARY_SECRET);
  });

  test("renders a human-readable line and an NDJSON doctor.check event", async () => {
    const result = await runWithDefault();
    const text = renderMcpDoctorResult(result);
    expect(text).toContain("mcp: pass");
    const now = new Date("2026-07-06T00:00:00.000Z");
    const ndjson = renderMcpDoctorResultAsNdjson(result, { now });
    expect(ndjson).toContain('"event":"doctor.check"');
    expect(ndjson).toContain('"name":"mcp"');
    expect(ndjson).not.toContain(MCP_DOCTOR_CANARY_SECRET);
  });
});
