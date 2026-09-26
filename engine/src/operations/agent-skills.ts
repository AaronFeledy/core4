import { Effect } from "effect";

import { LandofileFormConflictError, LandofileNotFoundError, LandofileParseError } from "@lando/sdk/errors";
import type { ManagedFileError } from "@lando/sdk/errors";
import type { ManagedFileAction, ManagedFileResult } from "@lando/sdk/schema";
import { ManagedFileService } from "@lando/sdk/services";

import { findAppRoot } from "@lando/landofile/discovery";
import { AGENT_SKILLS_OWNER, agentSkillManagedFiles } from "./agent-skills-pack.ts";

export {
  AGENT_SKILLS_OWNER,
  AGENT_SKILLS_SKILL_BODY,
  AGENT_SKILLS_SKILL_ID,
  AGENT_SKILLS_SKILL_PATH,
  agentSkillManagedFiles,
} from "./agent-skills-pack.ts";

export type AgentSkillsVerb = "install" | "update" | "remove";

export interface AgentSkillsFileResult {
  readonly id: string;
  readonly path: string;
  readonly action: ManagedFileAction;
}

export interface AgentSkillsResult {
  readonly verb: AgentSkillsVerb;
  readonly appRoot: string;
  readonly entries: ReadonlyArray<AgentSkillsFileResult>;
}

export interface AgentSkillsOptions {
  readonly cwd?: string;
  readonly appRoot?: string;
}

export type AgentSkillsError =
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileFormConflictError
  | ManagedFileError;

export const resolveAgentSkillsAppRoot = (
  options: AgentSkillsOptions,
): Effect.Effect<string, LandofileNotFoundError | LandofileParseError | LandofileFormConflictError> =>
  Effect.gen(function* () {
    if (options.appRoot !== undefined && options.appRoot !== "") return options.appRoot;
    const cwd = options.cwd ?? process.cwd();
    const appRoot = yield* Effect.tryPromise({
      try: () => findAppRoot(cwd),
      catch: (cause) =>
        cause instanceof LandofileFormConflictError
          ? cause
          : new LandofileParseError({
              message: cause instanceof Error ? cause.message : "Failed to discover Landofile.",
              filePath: cwd,
              line: undefined,
              column: undefined,
              cause,
            }),
    });
    if (appRoot === undefined) {
      return yield* Effect.fail(
        new LandofileNotFoundError({
          message:
            "No .lando.yml or .lando.ts found. Run `lando init` to create an app before installing agent skills.",
          cwd,
        }),
      );
    }
    return appRoot;
  });

const toEntries = (result: ManagedFileResult): ReadonlyArray<AgentSkillsFileResult> =>
  result.entries.map((entry) => ({
    id: entry.id,
    path: entry.path,
    action: entry.action,
  }));

const applyPack = (
  verb: Exclude<AgentSkillsVerb, "remove">,
  options: AgentSkillsOptions = {},
): Effect.Effect<AgentSkillsResult, AgentSkillsError, ManagedFileService> =>
  Effect.gen(function* () {
    const appRoot = yield* resolveAgentSkillsAppRoot(options);
    const managed = yield* ManagedFileService;
    const result = yield* Effect.scoped(managed.apply(agentSkillManagedFiles(appRoot)));
    return { verb, appRoot, entries: toEntries(result) };
  });

export const installAgentSkills = (
  options: AgentSkillsOptions = {},
): Effect.Effect<AgentSkillsResult, AgentSkillsError, ManagedFileService> => applyPack("install", options);

export const updateAgentSkills = (
  options: AgentSkillsOptions = {},
): Effect.Effect<AgentSkillsResult, AgentSkillsError, ManagedFileService> => applyPack("update", options);

export const removeAgentSkills = (
  options: AgentSkillsOptions = {},
): Effect.Effect<AgentSkillsResult, AgentSkillsError, ManagedFileService> =>
  Effect.gen(function* () {
    const appRoot = yield* resolveAgentSkillsAppRoot(options);
    const managed = yield* ManagedFileService;
    const result = yield* managed.remove({
      owner: AGENT_SKILLS_OWNER,
      base: appRoot,
    });
    return { verb: "remove", appRoot, entries: toEntries(result) };
  });
