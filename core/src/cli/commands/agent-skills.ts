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
} from "../../agent-skills/operations.ts";

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
  const lines = [
    `${verbLabel(result.verb)} agent skills in ${result.appRoot} (${result.entries.length} file${result.entries.length === 1 ? "" : "s"}).`,
  ];
  for (const entry of result.entries) {
    lines.push(`  ${ACTION_GLYPH[entry.action]} ${entry.path} (${entry.action})`);
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
