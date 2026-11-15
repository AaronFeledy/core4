import { boundedDiagnosticSummary, projectToolingDiagnostic } from "@lando/sdk/command-result";
import { ValidationIssue } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { Effect, Result, Schema } from "effect";
import type { McpAppGeneration } from "./apps";
import { stringifyBoundedJson } from "./bounded-json";
import { type McpAllowPolicy, isMcpEntryAuthorized } from "./catalog";
import type { McpCommandEntry } from "./registry";

export const McpDiagnostic = Schema.Struct({
  commandId: Schema.String,
  kind: Schema.Literals(["tooling", "plugin"]),
  _tag: Schema.String,
  message: Schema.String,
  remediation: Schema.optionalKey(Schema.String),
  sourceKind: Schema.optionalKey(Schema.Literals(["landofile", "bun-script"])),
  source: Schema.optionalKey(Schema.Struct({ path: Schema.String, task: Schema.String })),
  plugin: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      source: Schema.Literals(["bundled", "external"]),
      provenance: Schema.optionalKey(Schema.String),
    }),
  ),
  issues: Schema.optionalKey(Schema.Array(ValidationIssue)),
  omittedIssueCount: Schema.optionalKey(Schema.Number),
});
export type McpDiagnostic = typeof McpDiagnostic.Type;

export const McpDiagnostics = Schema.Struct({
  revision: Schema.Number,
  diagnostics: Schema.Array(McpDiagnostic),
  omittedDiagnosticCount: Schema.Number,
});
export type McpDiagnostics = typeof McpDiagnostics.Type;

/** Tooling freshness is independent of the contribution generation's selection fingerprint. */
export interface McpToolingCatalog {
  readonly revision: string;
  readonly entries: readonly Extract<McpCommandEntry, { readonly kind: "tooling" }>[];
  readonly unavailable: readonly McpDiagnostic[];
}

export const pluginDiagnostics = (
  generation: McpAppGeneration,
  policy: McpAllowPolicy,
): readonly McpDiagnostic[] =>
  [...generation.commands.values()].flatMap((command) => {
    const owner = command._tag === "Failed" ? command.owner : command.entry;
    if (owner === undefined || !isMcpEntryAuthorized(policy, owner)) return [];
    const diagnostics =
      command._tag === "Failed"
        ? command.diagnostic === undefined
          ? []
          : [command.diagnostic]
        : (command.diagnostics ?? []);
    return diagnostics.map((diagnostic) => ({
      ...diagnostic,
      commandId: owner.spec.id,
      kind: "plugin" as const,
      ...(owner.plugin === undefined ? {} : { plugin: owner.plugin }),
    }));
  });

const MAX_DIAGNOSTICS_BYTES = 16 * 1024;

/** Redact free text only: discriminants and literals keep their schema values. */
const redactRecord = (record: McpDiagnostic, redactor: Redactor): McpDiagnostic => {
  const text = (value: string) => redactor.redactString(value);
  return {
    ...record,
    message: boundedDiagnosticSummary(text(record.message), redactor),
    ...(record.remediation === undefined
      ? {}
      : { remediation: boundedDiagnosticSummary(text(record.remediation), redactor) }),
    ...(record.source === undefined
      ? {}
      : { source: { path: text(record.source.path), task: text(record.source.task) } }),
    ...(record.plugin?.provenance === undefined
      ? {}
      : { plugin: { ...record.plugin, provenance: text(record.plugin.provenance) } }),
  };
};

const toolingRecord = (record: McpDiagnostic, redactor: Redactor, maxBytes: number): McpDiagnostic => {
  const { source: _source, issues: _issues, omittedIssueCount: _omitted, ...metadata } = record;
  const {
    tool: _tool,
    source,
    ...diagnostic
  } = projectToolingDiagnostic(
    {
      _tag: "ToolingCompileError",
      tool: record.source?.task ?? record.commandId,
      ...(record.source === undefined ? {} : { source: record.source }),
      message: record.message,
      remediation: record.remediation ?? "Correct the tooling task definition and retry the command.",
      issues: record.issues ?? [],
      omittedIssueCount: record.omittedIssueCount ?? 0,
    },
    redactor,
    { maxBytes },
  );
  return { ...metadata, ...diagnostic, ...(source === undefined ? {} : { source }) };
};

const encodedBytes = (value: McpDiagnostics, redactor: Redactor): number | undefined => {
  const encoded = Effect.runSync(Effect.result(stringifyBoundedJson(value, "MCP diagnostics", redactor)));
  return Result.isSuccess(encoded) ? Buffer.byteLength(encoded.success) : undefined;
};

/** Filter before this boundary: even omitted counts must reveal only authorized records. */
export const boundDiagnostics = (
  revision: number,
  records: readonly McpDiagnostic[],
  redactor: Redactor,
): McpDiagnostics => {
  let result: McpDiagnostics = { revision, diagnostics: [], omittedDiagnosticCount: records.length };
  for (const record of records) {
    const isTooling = record.kind === "tooling" && record._tag === "ToolingCompileError";
    // A tooling record shrinks to the space the document leaves, down to its bounded summary.
    let budget = MAX_DIAGNOSTICS_BYTES;
    for (;;) {
      const next = {
        ...result,
        diagnostics: [
          ...result.diagnostics,
          isTooling ? toolingRecord(record, redactor, budget) : redactRecord(record, redactor),
        ],
        omittedDiagnosticCount: result.omittedDiagnosticCount - 1,
      };
      const bytes = encodedBytes(next, redactor);
      if (bytes !== undefined && bytes <= MAX_DIAGNOSTICS_BYTES) {
        result = next;
        break;
      }
      const reduced = bytes === undefined ? 0 : budget - (bytes - MAX_DIAGNOSTICS_BYTES);
      if (!isTooling || reduced <= 0 || reduced >= budget) break;
      budget = reduced;
    }
  }
  return result;
};
