/**
 * Session tool descriptors for ids that several discovered apps define.
 *
 * A session publishes one MCP tool per canonical id. When discovered apps contribute different
 * owners for an id, the published descriptor accepts every authorized variant: identical
 * contracts dedupe, otherwise the input and output schemas become top-level `anyOf` objects whose
 * branches name each variant's app and plugin. The call's selected owner stays authoritative for
 * validation, execution, and result encoding.
 */
import { createHash } from "node:crypto";

import { Schema } from "effect";
import * as McpSchema from "effect/ai/McpSchema";

import { isMcpDestructiveCommand } from "./allowlist";
import { type JsonSchemaObject, type McpCommandEntry, deriveToolInputSchema } from "./registry";
import { toolOutputSchema } from "./tool-result";

export interface McpToolVariant {
  readonly entry: McpCommandEntry;
  /** Where the variant comes from, for descriptions: owner plugin and app. */
  readonly label: string;
  readonly inputSchema: JsonSchemaObject;
  readonly outputSchema: Schema.JsonObject;
  /** Identity of the advertised contract (input + output schema). */
  readonly signature: string;
}

const ownerLabel = (entry: McpCommandEntry): string =>
  entry.plugin === undefined
    ? "built-in command"
    : `plugin ${entry.plugin.name} (${entry.plugin.provenance ?? entry.plugin.source})`;

export const makeToolVariant = (entry: McpCommandEntry, appKey: string | undefined): McpToolVariant => {
  const inputSchema = deriveToolInputSchema(entry.spec);
  const outputSchema = toolOutputSchema(entry.spec.resultSchema);
  return {
    entry,
    label: appKey === undefined ? ownerLabel(entry) : `${ownerLabel(entry)} in app ${appKey}`,
    inputSchema,
    outputSchema,
    signature: createHash("sha256")
      .update(JSON.stringify([inputSchema, outputSchema]))
      .digest("hex"),
  };
};

const decodeToolJson = Schema.decodeUnknownSync(McpSchema.ToolJson);
const decodeOutputJson = Schema.decodeUnknownSync(McpSchema.ToolOutputJson);

/** The single advertised tool for `variants`, plus the contracts it advertises. */
export const unionTool = (
  toolId: string,
  variants: readonly [McpToolVariant, ...McpToolVariant[]],
): { readonly tool: McpSchema.Tool; readonly signatures: ReadonlySet<string> } => {
  const [first] = variants;
  const unique: [McpToolVariant, ...McpToolVariant[]] = [first];
  const signatures = new Set([first.signature]);
  for (const variant of variants) {
    if (signatures.has(variant.signature)) continue;
    unique.push(variant);
    signatures.add(variant.signature);
  }
  const spec = first.entry.spec;
  if (unique.length === 1)
    return {
      tool: new McpSchema.Tool({
        name: toolId,
        title: spec.summary,
        description: spec.description ?? spec.summary,
        inputSchema: decodeToolJson(first.inputSchema),
        outputSchema: first.outputSchema,
      }),
      signatures,
    };
  const destructive = unique.some((variant) => isMcpDestructiveCommand(variant.entry.spec));
  const description = [
    spec.description ?? spec.summary,
    `Discovered apps define this tool differently: ${unique.map((variant) => variant.label).join("; ")}.`,
    "Pass appPath to choose the app; that app's variant validates the call.",
    ...(destructive ? ["Destructive in at least one variant."] : []),
  ].join(" ");
  return {
    tool: new McpSchema.Tool({
      name: toolId,
      title: spec.summary,
      description,
      inputSchema: decodeToolJson({
        type: "object",
        anyOf: unique.map((variant) => ({
          ...variant.inputSchema,
          description: `Input for ${variant.label}.`,
        })),
      }),
      outputSchema: decodeOutputJson({
        type: "object",
        anyOf: unique.map((variant) => ({
          ...variant.outputSchema,
          description: `Result from ${variant.label}.`,
        })),
      }),
    }),
    signatures,
  };
};
