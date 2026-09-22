import { Effect, Schema } from "effect";

import { ManagedFileAction } from "@lando/sdk/schema";
import { ManagedFileService } from "@lando/sdk/services";

import {
  type AgentSkillsError,
  type AgentSkillsFileResult,
  type AgentSkillsOptions,
  type AgentSkillsResult,
  type AgentSkillsVerb,
  installAgentSkills as installAgentSkillsOperation,
  removeAgentSkills as removeAgentSkillsOperation,
  resolveAgentSkillsAppRoot,
  updateAgentSkills as updateAgentSkillsOperation,
} from "@lando/engine/operations/agent-skills";
import { ManagedFileServiceFactory, ManagedFileServiceFactoryLive } from "@lando/managed-file/service";

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

const withAppManagedFiles = (
  options: AgentSkillsOptions,
  run: (appRoot: string) => Effect.Effect<AgentSkillsResult, AgentSkillsError, ManagedFileService>,
): Effect.Effect<AgentSkillsResult, AgentSkillsError> =>
  Effect.gen(function* () {
    const appRoot = yield* resolveAgentSkillsAppRoot(options);
    const factory = yield* ManagedFileServiceFactory;
    const managed = yield* factory.forBase(appRoot);
    return yield* run(appRoot).pipe(Effect.provideService(ManagedFileService, managed));
  }).pipe(Effect.provide(ManagedFileServiceFactoryLive));

export const installAgentSkills = (
  options: AgentSkillsOptions = {},
): Effect.Effect<AgentSkillsResult, AgentSkillsError> =>
  withAppManagedFiles(options, (appRoot) => installAgentSkillsOperation({ ...options, appRoot }));

export const updateAgentSkills = (
  options: AgentSkillsOptions = {},
): Effect.Effect<AgentSkillsResult, AgentSkillsError> =>
  withAppManagedFiles(options, (appRoot) => updateAgentSkillsOperation({ ...options, appRoot }));

export const removeAgentSkills = (
  options: AgentSkillsOptions = {},
): Effect.Effect<AgentSkillsResult, AgentSkillsError> =>
  withAppManagedFiles(options, (appRoot) => removeAgentSkillsOperation({ ...options, appRoot }));

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
