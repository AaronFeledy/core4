import { ValidationIssue } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { Schema } from "effect";
import type { McpAppGeneration } from "./apps";
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
  readonly entries: readonly McpCommandEntry[];
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

/** Filter before this boundary: even omitted counts must reveal only authorized records. */
export const boundDiagnostics = (
  revision: number,
  records: readonly McpDiagnostic[],
  redactor: Redactor,
): McpDiagnostics => {
  let result: McpDiagnostics = { revision, diagnostics: [], omittedDiagnosticCount: records.length };
  for (const record of records) {
    const safe = Schema.decodeUnknownSync(McpDiagnostic)(redactor.redactValue(record));
    const next = {
      ...result,
      diagnostics: [...result.diagnostics, safe],
      omittedDiagnosticCount: result.omittedDiagnosticCount - 1,
    };
    if (Buffer.byteLength(JSON.stringify(next)) <= 16 * 1024) result = next;
  }
  return result;
};
