/**
 * MCP diagnostics for `lando doctor`.
 *
 * The MCP surface is agent-facing, so `doctor` reports whether it is safe and
 * functional before a user wires an agent to it. The check is hermetic — it
 * runs against a test runtime (a synthetic canary command dispatched through an
 * in-memory execute seam), never the live provider — so it stays independent of
 * the selected provider and needs only `RedactionService`.
 *
 * Three sub-checks compose the single `mcp` check:
 *   1. allowlist cache integrity — the committed default allowlist is sorted and
 *      contains no destructive id. Drift from the compiled command index is
 *      covered by the generated-cache contract test, not by runtime doctor.
 *   2. catalog generation — the catalog projects cleanly and yields a tool with
 *      a derived input schema.
 *   3. canary round-trip — a canary tool dispatches to an `ok:true` envelope and
 *      a planted secret is redacted before the envelope is returned.
 *
 * All context values are routed through the `RedactionService` redactor, and no
 * raw tool payload (including the canary secret) is ever placed in the check.
 */
import { Effect, Fiber, Layer, Predicate, Schema } from "effect";

import * as EnvSecretStore from "@lando/engine/services/secret-store";
import { computeMcpDefaultAllowlist } from "@lando/mcp/allowlist";
import { buildCatalog, computeEffectiveAllowlist } from "@lando/mcp/catalog";
import { MCP_DEFAULT_ALLOWLIST } from "@lando/mcp/generated-allowlist";
import type { McpCommandEntry } from "@lando/mcp/registry";
import { McpRuntimeConfig, McpService } from "@lando/mcp/service";
import { startStdioClient } from "@lando/mcp/testing";
import { RedactionService } from "@lando/redaction/service";
import { serviceLayer } from "../../mcp-command-executor";
import type { LandoCommandSpec } from "../spec/command-base";
import type { DoctorSeverity, DoctorSolution, DoctorStatus } from "./doctor";
import { orderKnownKeys, renderDoctorChecksAsNdjson } from "./doctor-ndjson";
import { renderSectionCheck } from "./doctor-section-render";

export interface McpDoctorCheck {
  readonly name: "mcp";
  readonly status: DoctorStatus;
  readonly severity: DoctorSeverity;
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<DoctorSolution>;
}

export interface McpDoctorResult {
  readonly checks: ReadonlyArray<McpDoctorCheck>;
}

/**
 * A deterministic fake secret planted in the canary result to prove the
 * redaction path masks command output before it crosses the MCP transport. It
 * is not a real credential; it exists only so the doctor check can assert it
 * never appears in the returned envelope.
 */
export const MCP_DOCTOR_CANARY_SECRET = "lando-mcp-doctor-canary-secret-do-not-use";

const CANARY_TOOL_ID = "meta:mcp-doctor-canary";

const canarySpec: LandoCommandSpec = {
  id: CANARY_TOOL_ID,
  summary: "MCP doctor canary tool.",
  namespace: "meta",
  bootstrap: "minimal",
  resultSchema: Schema.Struct({ token: Schema.String }),
  run: () => Effect.succeed({ token: MCP_DOCTOR_CANARY_SECRET }),
  redactionTokens: () => [MCP_DOCTOR_CANARY_SECRET],
};

const canaryEntry: McpCommandEntry = { spec: canarySpec };

export const isMcpDefaultAllowlistFresh = (ids: ReadonlyArray<string>): boolean => {
  const expected = computeMcpDefaultAllowlist(MCP_DEFAULT_ALLOWLIST.map((id) => ({ id, mcpAllowed: true })));
  if (ids.length !== expected.length) return false;
  return ids.every((id, index) => id === expected[index]);
};

interface McpDoctorSignals {
  readonly allowlistFresh: boolean;
  readonly catalogGenerated: boolean;
  readonly canaryRoundTrip: boolean;
  readonly canaryRedacted: boolean;
}

const MCP_ALLOWLIST_STALE_SOLUTION: DoctorSolution = {
  kind: "manual",
  description:
    "The committed MCP default allowlist is stale. Regenerate `mcp/src/generated/mcp-allowlist.ts` from the compiled command index.",
  command: "bun run scripts/build-mcp-allowlist.ts",
};

const MCP_CATALOG_DEGRADED_SOLUTION: DoctorSolution = {
  kind: "manual",
  description:
    "The MCP catalog failed to project command metadata. Rerun `lando doctor`; if it persists this is a regression in the MCP projection.",
  command: "lando doctor",
};

const MCP_CANARY_DEGRADED_SOLUTION: DoctorSolution = {
  kind: "manual",
  description:
    "The MCP canary round-trip or redaction self-check failed. Rerun `lando doctor`; if it persists this is a regression in MCP dispatch or redaction.",
  command: "lando doctor",
};

const mcpDoctorSolutions = (signals: McpDoctorSignals): ReadonlyArray<DoctorSolution> => {
  const solutions: DoctorSolution[] = [];
  if (!signals.allowlistFresh) solutions.push(MCP_ALLOWLIST_STALE_SOLUTION);
  if (!signals.catalogGenerated) solutions.push(MCP_CATALOG_DEGRADED_SOLUTION);
  if (!signals.canaryRoundTrip || !signals.canaryRedacted) solutions.push(MCP_CANARY_DEGRADED_SOLUTION);
  return solutions;
};

/**
 * Build the `mcp` doctor check. Returns a single `pass` check when the allowlist
 * cache is fresh, the catalog projects cleanly, and the canary tool
 * round-trips with its secret redacted; otherwise a `fail` check carrying the
 * failing signals and a remediation.
 */
export const mcpDoctor = Effect.fn("McpDoctor.check")(function* (): Effect.fn.Return<
  McpDoctorResult,
  never,
  RedactionService
> {
  const redaction = yield* RedactionService;
  const redactor = yield* redaction.forProfile("secrets", {
    redactionTokens: [MCP_DOCTOR_CANARY_SECRET],
    sourceEnv: process.env,
  });

  const allowlistFreshResult = yield* Effect.result(
    Effect.try(() => isMcpDefaultAllowlistFresh(MCP_DEFAULT_ALLOWLIST)),
  );
  const allowlistFresh = allowlistFreshResult._tag === "Success" && allowlistFreshResult.success;

  const catalog = yield* Effect.result(
    Effect.try(() =>
      buildCatalog({
        commandEntries: [canaryEntry],
        effective: computeEffectiveAllowlist({ defaults: [CANARY_TOOL_ID] }),
      }),
    ),
  );
  const catalogTools = catalog._tag === "Success" ? catalog.success.tools.length : 0;
  const catalogGenerated =
    catalog._tag === "Success" &&
    catalogTools > 0 &&
    Predicate.isObject(catalog.success.tools[0]?.inputSchema);

  const dispatch = yield* Effect.result(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* McpService;
        const client = yield* startStdioClient(service.serve({ transport: "stdio" }));
        const response = yield* client.request("tools/call", { name: CANARY_TOOL_ID });
        yield* client.close;
        yield* Fiber.join(client.fiber);
        return response;
      }),
    ).pipe(
      Effect.provide(serviceLayer),
      Effect.provideService(
        McpRuntimeConfig,
        McpRuntimeConfig.of({
          commandEntries: [canaryEntry],
          defaultAllowlist: [CANARY_TOOL_ID],
          runtimeLayer: Layer.succeed(RedactionService, redaction),
        }),
      ),
      Effect.timeout("10 seconds"),
    ),
  );
  const toolResult = dispatch._tag === "Success" ? dispatch.success.result : undefined;
  const structured = Predicate.isObject(toolResult) ? toolResult.structuredContent : undefined;
  const canaryRoundTrip = Predicate.isObject(structured) && structured.ok === true;
  const envelopeText = dispatch._tag === "Success" ? JSON.stringify(dispatch.success) : "";
  const canaryRedacted = canaryRoundTrip && !envelopeText.includes(MCP_DOCTOR_CANARY_SECRET);
  const canaryError =
    dispatch._tag === "Failure" ? redactor.redactString(dispatch.failure.message) : undefined;

  const passed = allowlistFresh && catalogGenerated && canaryRoundTrip && canaryRedacted;

  const context: Record<string, string> = {
    allowlistFresh: redactor.redactString(String(allowlistFresh)),
    allowlistSize: redactor.redactString(String(MCP_DEFAULT_ALLOWLIST.length)),
    catalogGenerated: redactor.redactString(String(catalogGenerated)),
    catalogTools: redactor.redactString(String(catalogTools)),
    canaryRoundTrip: redactor.redactString(String(canaryRoundTrip)),
    canaryRedacted: redactor.redactString(String(canaryRedacted)),
  };
  if (allowlistFreshResult._tag === "Failure")
    context.allowlistError = redactor.redactString(String(allowlistFreshResult.failure));
  if (canaryError !== undefined) context.canaryError = canaryError;

  const check: McpDoctorCheck = {
    name: "mcp",
    status: passed ? "pass" : "fail",
    severity: passed ? "info" : "error",
    context,
    solutions: passed
      ? []
      : mcpDoctorSolutions({ allowlistFresh, catalogGenerated, canaryRoundTrip, canaryRedacted }),
  };
  return { checks: [check] };
});

/**
 * Default layer for {@link mcpDoctor}: provides `RedactionService` from the
 * env-backed `SecretStore`, so the check needs no ambient services beyond it.
 */
export const DefaultMcpDoctorLayer: Layer.Layer<RedactionService, never, never> = RedactionService.layer.pipe(
  Layer.provide(EnvSecretStore.layer),
);

export const renderMcpDoctorResult = (result: McpDoctorResult): string =>
  result.checks.flatMap((check) => renderSectionCheck(check)).join("\n");

const CONTEXT_KEY_ORDER: ReadonlyArray<string> = [
  "allowlistFresh",
  "allowlistSize",
  "catalogGenerated",
  "catalogTools",
  "canaryRoundTrip",
  "canaryRedacted",
  "allowlistError",
  "canaryError",
];

const orderContextKeys = (context: Readonly<Record<string, string>>): Record<string, string> =>
  orderKnownKeys(context, CONTEXT_KEY_ORDER);

const checkEventPayload = (check: McpDoctorCheck): Record<string, unknown> => ({
  _tag: "doctor.check",
  name: check.name,
  status: check.status,
  severity: check.severity,
  context: orderContextKeys(check.context),
  solutions: check.solutions.map((solution) => ({
    kind: solution.kind,
    description: solution.description,
    ...(solution.command === undefined ? {} : { command: solution.command }),
  })),
});

export interface McpDoctorNdjsonOptions {
  readonly now?: Date;
}

export const renderMcpDoctorResultAsNdjson = (
  result: McpDoctorResult,
  options: McpDoctorNdjsonOptions = {},
): string =>
  renderDoctorChecksAsNdjson({
    checks: result.checks,
    now: options.now,
    checkEventPayload,
  });
