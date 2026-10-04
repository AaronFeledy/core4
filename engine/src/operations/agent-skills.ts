import { Effect, Schema } from "effect";

import {
  LandofileFormConflictError,
  LandofileNotFoundError,
  LandofileParseError,
  ManagedFileError,
} from "@lando/sdk/errors";
import { ManagedFileAction, type ManagedFileResult } from "@lando/sdk/schema";
import { ManagedFileService } from "@lando/sdk/services";

import { findAppRoot } from "@lando/landofile/discovery";
import { AGENT_SKILLS_OWNER, agentSkillManagedFiles } from "./agent-skills-pack.ts";
import { canonicalAppRoot } from "./app-root-identity.ts";

export {
  AGENT_SKILLS_OWNER,
  AGENT_SKILLS_SKILL_BODY,
  AGENT_SKILLS_SKILL_ID,
  AGENT_SKILLS_SKILL_PATH,
  agentSkillManagedFiles,
} from "./agent-skills-pack.ts";

export const AgentSkillsVerbSchema = Schema.Literals(["install", "update", "remove"]);
export type AgentSkillsVerb = typeof AgentSkillsVerbSchema.Type;

export const AgentSkillsFileResultSchema = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  action: ManagedFileAction,
});
export type AgentSkillsFileResult = typeof AgentSkillsFileResultSchema.Type;

export const AgentSkillsResultSchema = Schema.Struct({
  verb: AgentSkillsVerbSchema,
  appRoot: Schema.String,
  entries: Schema.Array(AgentSkillsFileResultSchema),
});
export type AgentSkillsResult = typeof AgentSkillsResultSchema.Type;

export interface AgentSkillsOptions {
  readonly cwd?: string;
  readonly appRoot?: string;
}

export type AgentSkillsError =
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileFormConflictError
  | ManagedFileError;

export const resolveAgentSkillsAppRoot = Effect.fn("resolveAgentSkillsAppRoot")(
  (options: AgentSkillsOptions): Effect.Effect<string, AgentSkillsError> =>
    Effect.gen(function* () {
      const cwd = options.cwd ?? process.cwd();
      const appRoot =
        options.appRoot !== undefined && options.appRoot !== ""
          ? options.appRoot
          : yield* Effect.tryPromise({
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
      return yield* canonicalAppRoot(appRoot).pipe(
        Effect.mapError(
          (error) =>
            new ManagedFileError({
              reason: "path",
              operation: "plan",
              path: appRoot,
              cause: error.cause,
              remediation: error.remediation,
            }),
        ),
      );
    }),
);

const toEntries = (result: ManagedFileResult): ReadonlyArray<AgentSkillsFileResult> =>
  result.entries.map((entry) => ({
    id: entry.id,
    path: entry.path,
    action: entry.action,
  }));

const applyPack = Effect.fn("applyPack")(
  (
    verb: Exclude<AgentSkillsVerb, "remove">,
    options: AgentSkillsOptions = {},
  ): Effect.Effect<AgentSkillsResult, AgentSkillsError, ManagedFileService> =>
    Effect.gen(function* () {
      const appRoot = yield* resolveAgentSkillsAppRoot(options);
      const managed = yield* ManagedFileService;
      const result = yield* Effect.scoped(managed.apply(agentSkillManagedFiles(appRoot)));
      return { verb, appRoot, entries: toEntries(result) };
    }),
);

export const installAgentSkills = (
  options: AgentSkillsOptions = {},
): Effect.Effect<AgentSkillsResult, AgentSkillsError, ManagedFileService> => applyPack("install", options);

export const updateAgentSkills = (
  options: AgentSkillsOptions = {},
): Effect.Effect<AgentSkillsResult, AgentSkillsError, ManagedFileService> => applyPack("update", options);

export const removeAgentSkills = Effect.fn("removeAgentSkills")(
  (
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
    }),
);
