/**
 * MCP command-registry projection.
 *
 * The MCP catalog is a projection of the canonical `LandoCommandSpec` registry
 *: one tool per allowlisted command id, with an input schema derived
 * from the command's declared `flags`/`args`. This module owns the pure
 * derivation and validation logic — no command graph, no Effect runtime — so a
 * consumer can build a catalog or validate a tool input without pulling the
 * compiled CLI into scope.
 */
import { McpToolInputError } from "@lando/sdk/errors";

import type { LandoCommandSpec } from "../cli/oclif/command-base.ts";

/** A single command projected as an MCP tool. */
export interface McpCommandEntry {
  readonly spec: LandoCommandSpec;
  /** True only for tooling-task tools (projection); false for command tools. */
  readonly tooling?: boolean;
}

/**
 * The FlagSpec/ArgSpec view the derivation reads. `LandoCommandSpec.flags` /
 * `.args` are keyed by name; each value is interpreted as this shape.
 */
export interface McpInputMemberView {
  readonly type?: "string" | "boolean" | "number";
  readonly description?: string;
  readonly required?: boolean;
  readonly multiple?: boolean;
}

/** A JSON-Schema-shaped object (the value carried in `McpToolDescriptor.inputSchema`). */
export type JsonSchemaObject = Record<string, unknown>;

const asView = (value: unknown): McpInputMemberView =>
  value !== null && typeof value === "object" ? (value as McpInputMemberView) : {};

const jsonTypeFor = (view: McpInputMemberView): string => {
  const base = view.type ?? "string";
  return view.multiple === true ? "array" : base;
};

const memberSchema = (view: McpInputMemberView): JsonSchemaObject => {
  const base: JsonSchemaObject =
    view.multiple === true
      ? { type: "array", items: { type: view.type ?? "string" } }
      : { type: view.type ?? "string" };
  return view.description === undefined ? base : { ...base, description: view.description };
};

const groupSchema = (members: Readonly<Record<string, unknown>> | undefined): JsonSchemaObject => {
  const properties: JsonSchemaObject = {};
  const required: string[] = [];
  for (const [name, raw] of Object.entries(members ?? {})) {
    const view = asView(raw);
    properties[name] = memberSchema(view);
    if (view.required === true) required.push(name);
  }
  const schema: JsonSchemaObject = { type: "object", properties, additionalProperties: false };
  return required.length === 0 ? schema : { ...schema, required };
};

/**
 * Derive the JSON-Schema-shaped input object for a command tool from its
 * declared `flags`/`args`. Commands that declare neither get a closed object
 * with empty `flags`/`args` groups.
 */
export const deriveToolInputSchema = (spec: LandoCommandSpec): JsonSchemaObject => ({
  type: "object",
  properties: {
    flags: groupSchema(spec.flags),
    args: groupSchema(spec.args),
  },
  additionalProperties: false,
});

/** The `{ flags?, args? }` payload an MCP tool call carries. */
export interface McpToolInput {
  readonly flags?: Record<string, unknown>;
  readonly args?: Record<string, unknown>;
  /** Optional app path used for per-call app resolution; not part of the derived schema. */
  readonly appPath?: string;
}

const typeMatches = (view: McpInputMemberView, value: unknown): boolean => {
  if (view.multiple === true) return Array.isArray(value);
  switch (view.type ?? "string") {
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    default:
      return typeof value === "string";
  }
};

const validateGroup = (
  toolId: string,
  group: "flags" | "args",
  members: Readonly<Record<string, unknown>> | undefined,
  provided: Record<string, unknown> | undefined,
): void => {
  const declared = members ?? {};
  const values = provided ?? {};
  for (const [name, value] of Object.entries(values)) {
    if (!(name in declared)) {
      throw new McpToolInputError({
        message: `Unknown ${group === "flags" ? "flag" : "argument"} "${name}" for tool ${toolId}.`,
        toolId,
        path: `${group}.${name}`,
        remediation: `Remove "${group}.${name}"; it is not part of the tool's input schema.`,
      });
    }
    const view = asView(declared[name]);
    if (!typeMatches(view, value)) {
      throw new McpToolInputError({
        message: `Invalid type for ${group}.${name} on tool ${toolId}; expected ${jsonTypeFor(view)}.`,
        toolId,
        path: `${group}.${name}`,
        remediation: `Provide ${group}.${name} as a ${jsonTypeFor(view)} value.`,
      });
    }
  }
  for (const [name, raw] of Object.entries(declared)) {
    const view = asView(raw);
    if (view.required === true && !(name in values)) {
      throw new McpToolInputError({
        message: `Missing required ${group === "flags" ? "flag" : "argument"} "${name}" for tool ${toolId}.`,
        toolId,
        path: `${group}.${name}`,
        remediation: `Provide "${group}.${name}" in the tool call input.`,
      });
    }
  }
};

/**
 * Validate a tool-call input against a command's derived schema. Throws
 * {@link McpToolInputError} carrying the offending `flags.<name>` / `args.<name>`
 * path. Returns the normalized `{ flags, args }` payload on success.
 */
export const validateToolInput = (
  spec: LandoCommandSpec,
  input: McpToolInput | undefined,
): { readonly flags: Record<string, unknown>; readonly args: Record<string, unknown> } => {
  const flags = input?.flags ?? {};
  const args = input?.args ?? {};
  validateGroup(spec.id, "flags", spec.flags, flags);
  validateGroup(spec.id, "args", spec.args, args);
  return { flags, args };
};
