import { type Effect, Schema } from "effect";

import { ManagedFileAction } from "@lando/sdk/schema";
import type { ManagedFileService } from "@lando/sdk/services";

import {
  type AgentSkillsError,
  type AgentSkillsFileResult,
  type AgentSkillsOptions,
  type AgentSkillsResult,
  type AgentSkillsVerb,
  installAgentSkills as installAgentSkillsOperation,
  removeAgentSkills as removeAgentSkillsOperation,
  updateAgentSkills as updateAgentSkillsOperation,
} from "@lando/engine/operations/agent-skills";

export type {
  AgentSkillsError,
  AgentSkillsFileResult,
  AgentSkillsOptions,
  AgentSkillsResult,
  AgentSkillsVerb,
};

export const AgentSkillsFileResultSchema = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  action: ManagedFileAction,
});

export const AgentSkillsResultSchema = Schema.Struct({
  verb: Schema.Literal("install", "update", "remove"),
  appRoot: Schema.String,
  entries: Schema.Array(AgentSkillsFileResultSchema),
});

export const installAgentSkills = (
  options: AgentSkillsOptions = {},
): Effect.Effect<AgentSkillsResult, AgentSkillsError, ManagedFileService> =>
  installAgentSkillsOperation(options);

export const updateAgentSkills = (
  options: AgentSkillsOptions = {},
): Effect.Effect<AgentSkillsResult, AgentSkillsError, ManagedFileService> =>
  updateAgentSkillsOperation(options);

export const removeAgentSkills = (
  options: AgentSkillsOptions = {},
): Effect.Effect<AgentSkillsResult, AgentSkillsError, ManagedFileService> =>
  removeAgentSkillsOperation(options);

const ACTION_GLYPH: Readonly<Record<ManagedFileAction, string>> = {
  create: "+",
  update: "~",
  "skip-unchanged": "=",
  "skip-adopted": "!",
  conflict: "!",
  "adopt-detected": "!",
};

const presentEntry = (
  verb: AgentSkillsVerb,
  action: ManagedFileAction,
): { readonly glyph: string; readonly label: string } => {
  if (verb === "remove" && action === "update") {
    return { glyph: "-", label: "remove" };
  }
  return { glyph: ACTION_GLYPH[action], label: action };
};

const verbLabel = (verb: AgentSkillsVerb): string => {
  switch (verb) {
    case "install":
      return "Installed";
    case "update":
      return "Updated";
    case "remove":
      return "Removed";
  }
};

export const renderAgentSkillsResult = (result: AgentSkillsResult): string => {
  const heading =
    result.verb === "remove"
      ? `Processed agent skill removal in ${result.appRoot}`
      : `${verbLabel(result.verb)} agent skills in ${result.appRoot}`;
  const lines = [`${heading} (${result.entries.length} file${result.entries.length === 1 ? "" : "s"}).`];
  for (const entry of result.entries) {
    const presented = presentEntry(result.verb, entry.action);
    lines.push(`  ${presented.glyph} ${entry.path} (${presented.label})`);
  }
  if (result.entries.length === 0) {
    lines.push(
      result.verb === "remove"
        ? "  (no Lando-owned agent skill files to remove)"
        : "  (no agent skill files written)",
    );
  }
  return lines.join("\n");
};
