import { Schema } from "effect";
import { AgentSkillsResultSchema } from "./agent-skills.ts";

export const RecipeInitPreviewSchema = Schema.Struct({
  landofile: Schema.String,
  outputs: Schema.Array(
    Schema.Struct({
      destination: Schema.String,
      mode: Schema.Number,
      digest: Schema.String,
      bytes: Schema.Number,
    }),
  ),
  actions: Schema.Array(
    Schema.Struct({ index: Schema.Number, type: Schema.String, authorized: Schema.Boolean }),
  ),
  conflicts: Schema.Array(Schema.String),
  skippedScaffold: Schema.Array(Schema.String),
});
export const RecipeReadinessFields = {
  initializable: Schema.Literal(true),
  readiness: Schema.Literals(["requires-input", "ready", "conflict"]),
  missingAnswers: Schema.Array(Schema.String),
  historyEligible: Schema.Boolean,
  preview: Schema.optionalKey(RecipeInitPreviewSchema),
};
export const InitAppResultSchema = Schema.Struct({
  appName: Schema.String,
  directory: Schema.String,
  answers: Schema.Record(Schema.String, Schema.Unknown),
  postInit: Schema.Struct({
    executed: Schema.Array(
      Schema.Struct({
        index: Schema.Number,
        type: Schema.String,
        verb: Schema.optionalKey(Schema.String),
        skipped: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  }),
  skippedScaffold: Schema.Array(Schema.String),
  preview: RecipeInitPreviewSchema,
  receipt: Schema.Struct({
    id: Schema.String,
    written: Schema.Array(Schema.String),
    removed: Schema.Array(Schema.String),
    backups: Schema.Array(Schema.String),
    created: Schema.Array(Schema.Struct({ path: Schema.String, digest: Schema.String, mode: Schema.Number })),
  }),
  agentSkills: Schema.optionalKey(AgentSkillsResultSchema),
});
